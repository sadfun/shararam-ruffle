use crate::{
    auth::{LoginRequest, LoginResult, OFFICIAL_ORIGIN, OfficialSession},
    state::{AppState, CachedBase},
    tunnel::{self, TunnelQuery},
};
use anyhow::Context;
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Path, Query, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use futures_util::{Stream, StreamExt};
use regex::Regex;
use rust_embed::RustEmbed;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path as FilePath, PathBuf},
    sync::{Arc, atomic::Ordering},
};
use uuid::Uuid;

#[derive(RustEmbed)]
#[folder = "../web/"]
struct WebAssets;

/// Replaced in the served `index.html` with the current capability token so the
/// page carries it without exposing it in the URL. See [`static_response`].
const CAPABILITY_PLACEHOLDER: &str = "__SHARARAM_CAP__";

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(static_index))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/shared-object", get(shared_object))
        .route("/api/status", get(status))
        .route("/game/base.swf", get(official_base))
        .route("/socket-proxy", get(socket_proxy))
        .route("/official/{*path}", any(official_proxy))
        .route("/{*path}", get(static_asset))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state)
}

async fn security_headers(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_str(&content_security_policy(&state)).expect("static CSP is header-safe"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

/// The socket tunnel is same-origin: on loopback it is `ws://` to the local
/// port, and in public mode it is `wss://` to the external host that the
/// reverse proxy terminates. Everything else stays `'self'`.
fn content_security_policy(state: &AppState) -> String {
    let connect_src = match state.public_host() {
        Some(host) => format!("connect-src 'self' wss://{host}"),
        None => "connect-src 'self' ws://127.0.0.1:* ws://localhost:*".to_string(),
    };
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; {connect_src}; \
         img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; \
         worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'"
    )
}

async fn static_index(State(state): State<AppState>) -> Response {
    static_response("index.html", Some(state.capability()))
}
async fn static_asset(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    // The capability token reaches remote browsers only through the served
    // page; every other asset is returned verbatim.
    let inject = (path == "index.html").then(|| state.capability());
    static_response(&path, inject)
}

fn static_response(path: &str, inject_capability: Option<&str>) -> Response {
    match WebAssets::get(path) {
        Some(asset) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let body = match inject_capability {
                Some(capability) => Body::from(
                    String::from_utf8_lossy(&asset.data)
                        .replace(CAPABILITY_PLACEHOLDER, capability)
                        .into_bytes(),
                ),
                None => Body::from(asset.data.into_owned()),
            };
            let mut response = body.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime.as_ref()).unwrap(),
            );
            // The executable embeds these files. A restarted development build
            // can therefore serve different bytes from the same loopback URL.
            // Never reuse assets from a previous executable build.
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<LoginRequest>,
) -> Response {
    if !valid_capability_header(&state, &headers) {
        return forbidden();
    }
    match OfficialSession::login(&request.login, &request.password).await {
        Ok(session) => {
            let id = Uuid::new_v4().to_string();
            state.sessions.write().await.insert(id.clone(), session);
            // Behind the public reverse proxy the browser talks HTTPS, so the
            // session cookie must be `Secure`; on loopback it must not be, or
            // the browser would drop it over plain HTTP.
            let secure = if state.is_public() { "; Secure" } else { "" };
            let cookie = format!("shlive_session={id}; Path=/; HttpOnly; SameSite=Strict{secure}");
            let mut response = axum::Json(LoginResult { ok: true }).into_response();
            response
                .headers_mut()
                .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
            response
        }
        Err(error) => (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// Drops the official session this browser holds. Without it a reload would
/// simply walk back into the game, because the cookie still resolves.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !valid_capability_header(&state, &headers) {
        return forbidden();
    }
    if let Some(id) = session_id(&headers) {
        state.sessions.write().await.remove(id);
    }
    let mut response = axum::Json(json!({"ok": true})).into_response();
    expire_session_cookie(&state, &mut response);
    response
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !valid_capability_header(&state, &headers) {
        return forbidden();
    }
    let authenticated = if let Some(id) = session_id(&headers) {
        state.sessions.read().await.contains_key(id)
    } else {
        false
    };
    // Diagnostics expose server-wide byte counters and the last tunnel error;
    // keep them for the local debug panel but never on a shared public server.
    if state.is_public() {
        return axum::Json(json!({"authenticated": authenticated})).into_response();
    }
    let diagnostics = state.diagnostics.read().await.clone();
    axum::Json(json!({"authenticated": authenticated, "diagnostics": diagnostics})).into_response()
}

const SHARARAM_SHARED_OBJECT_KEY: &str = "www.shararam.ru/base.swf/shararam.v.3";

async fn shared_object(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !valid_capability_header(&state, &headers) {
        return forbidden();
    }
    let Some(bytes) = find_native_shared_object().await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let mut response = Body::from(bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        "x-shararam-shared-object-key",
        HeaderValue::from_static(SHARARAM_SHARED_OBJECT_KEY),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn find_native_shared_object() -> Option<Vec<u8>> {
    let app_data = std::env::var_os("APPDATA")?;
    let root = PathBuf::from(app_data)
        .join("Shararam")
        .join("Pepper Data")
        .join("Shockwave Flash")
        .join("WritableRoot")
        .join("#SharedObjects");
    let mut directories = tokio::fs::read_dir(root).await.ok()?;
    while let Ok(Some(directory)) = directories.next_entry().await {
        let candidate = native_shared_object_path(&directory.path());
        let Ok(bytes) = tokio::fs::read(candidate).await else {
            continue;
        };
        if bytes.len() <= 64 * 1024 && bytes.starts_with(&[0x00, 0xbf]) {
            return Some(bytes);
        }
    }
    None
}

fn native_shared_object_path(root: &FilePath) -> PathBuf {
    root.join("www.shararam.ru")
        .join("base.swf")
        .join("shararam.v.3.sol")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResult {
    parameters: HashMap<String, String>,
    swf_url: String,
}

async fn bootstrap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    bootstrap_from_origin(state, headers, OFFICIAL_ORIGIN).await
}

async fn bootstrap_from_origin(
    state: AppState,
    headers: HeaderMap,
    official_origin: &str,
) -> Response {
    if !valid_capability_header(&state, &headers) {
        return forbidden();
    }
    let Some(session_id) = session_id(&headers).map(str::to_owned) else {
        return (StatusCode::UNAUTHORIZED, "Login required").into_response();
    };
    let Some(session) = state.sessions.read().await.get(&session_id).cloned() else {
        return (StatusCode::UNAUTHORIZED, "Login required").into_response();
    };
    let page = match fetch_official_bootstrap(&session.client, official_origin).await {
        Ok(Some(page)) => page,
        Ok(None) => {
            state.sessions.write().await.remove(&session_id);
            return expired_session(&state);
        }
        Err(error) => return internal(error),
    };
    let parameters = match parse_official_flashvars(&page) {
        Ok(parameters) => parameters,
        Err(error) => return internal(error),
    };
    let swf_url = match official_swf_url(&page) {
        Ok(swf_url) => swf_url,
        Err(error) => return internal(error),
    };
    *session.swf_url.write().await = Some(swf_url.clone());
    axum::Json(BootstrapResult {
        parameters,
        swf_url,
    })
    .into_response()
}

async fn fetch_official_bootstrap(
    client: &wreq_transport::Client,
    origin: &str,
) -> anyhow::Result<Option<String>> {
    // Do not follow /game -> /login. Following it hides an expired official
    // session and makes the login page look like a malformed game bootstrap.
    let response = client
        .get(format!("{origin}/game"))
        .redirect(wreq_transport::redirect::Policy::none())
        .send()
        .await?;
    if is_login_redirect(response.status(), response.headers()) {
        return Ok(None);
    }
    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("<missing Location>");
        anyhow::bail!("official /game redirected unexpectedly to {location}");
    }
    let page = response.error_for_status()?.text().await?;
    Ok(Some(page))
}

fn is_login_redirect(status: StatusCode, headers: &HeaderMap) -> bool {
    status.is_redirection()
        && headers
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<Uri>().ok())
            .is_some_and(|location| location.path() == "/login")
}

fn expired_session(state: &AppState) -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({"error": "Сессия истекла. Войдите снова."})),
    )
        .into_response();
    expire_session_cookie(state, &mut response);
    response
}

fn expire_session_cookie(state: &AppState, response: &mut Response) {
    let secure = if state.is_public() { "; Secure" } else { "" };
    let cookie = format!("shlive_session=; Path=/; HttpOnly; SameSite=Strict{secure}; Max-Age=0");
    response
        .headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
}

fn official_swf_url(page: &str) -> anyhow::Result<String> {
    let version = parse_official_option(page, "version")
        .context("official /game bootstrap has no base.swf version")?;
    let version = version
        .parse::<u64>()
        .context("official base.swf version is not numeric")?;
    Ok(format!("{OFFICIAL_ORIGIN}/base.swf?v={version}"))
}

fn parse_official_flashvars(page: &str) -> anyhow::Result<HashMap<String, String>> {
    let double_quoted = Regex::new(r#"(?is)<embed\b[^>]*\bflashvars\s*=\s*"([^"]*)""#)
        .expect("static FlashVars regex");
    let single_quoted = Regex::new(r#"(?is)<embed\b[^>]*\bflashvars\s*=\s*'([^']*)'"#)
        .expect("static FlashVars regex");
    let encoded = double_quoted
        .captures(page)
        .or_else(|| single_quoted.captures(page))
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str());
    let parameters = if let Some(encoded) = encoded {
        let decoded = encoded
            .replace("&amp;", "&")
            .replace("&#38;", "&")
            .replace("&#x26;", "&");
        url::form_urlencoded::parse(decoded.as_bytes())
            .into_owned()
            .collect::<HashMap<_, _>>()
    } else {
        // The current page creates its <embed> in JavaScript. Read only the
        // public bootstrap fields which that script turns into FlashVars.
        let game_files = parse_official_option(page, "urlGameSwfFiles")
            .context("official /game bootstrap has no urlGameSwfFiles")?;
        let game_server = parse_official_option(page, "urlGameServer")
            .context("official /game bootstrap has no urlGameServer")?;
        let mut parameters = HashMap::from([
            ("game_server".into(), game_server),
            ("url_path_server".into(), game_files.clone()),
            ("portal_url".into(), game_files),
            ("manual_server_selection".into(), String::new()),
            (
                "start_step".into(),
                parse_official_option(page, "gameStartStep")
                    .context("official /game bootstrap has no gameStartStep")?,
            ),
            (
                "domainId".into(),
                parse_official_option(page, "domainId")
                    .context("official /game bootstrap has no domainId")?,
            ),
            (
                "useHashInName".into(),
                parse_official_option(page, "useHashInName")
                    .context("official /game bootstrap has no useHashInName")?,
            ),
            (
                "splcid".into(),
                parse_official_option(page, "splcid")
                    .context("official /game bootstrap has no splcid")?,
            ),
            (
                "client".into(),
                parse_official_option(page, "client")
                    .context("official /game bootstrap has no client")?,
            ),
        ]);
        if let Some(value) = parse_official_option(page, "gameStartAction") {
            parameters.insert("start_action".into(), value);
        }
        if let Some(value) = parse_official_option(page, "gameReferalName") {
            parameters.insert("referalName".into(), value);
        }
        parameters
    };
    for required in [
        "game_server",
        "url_path_server",
        "portal_url",
        "start_step",
        "client",
    ] {
        if !parameters.contains_key(required) {
            anyhow::bail!("official FlashVars are missing {required}");
        }
    }
    Ok(parameters)
}

fn parse_official_option(page: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?m)^\s*{}\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\r\n}}]+))"#,
        regex::escape(name)
    );
    let capture = Regex::new(&pattern).ok()?.captures(page)?;
    let value = capture
        .get(1)
        .or_else(|| capture.get(2))
        .or_else(|| capture.get(3))?
        .as_str()
        .trim();
    (!matches!(value, "undefined" | "null")).then(|| value.to_string())
}

async fn official_base(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(session) = session(&state, &headers).await else {
        tracing::info!("official base rejected: no local session");
        return (StatusCode::UNAUTHORIZED, "Login required").into_response();
    };
    if let Some(cached) = state.official_base.read().await.clone() {
        tracing::info!(
            sha256 = %cached.sha256,
            bytes = cached.bytes.len(),
            "serving cached current base"
        );
        return swf_response(cached);
    }
    let official = match session
        .client
        .get(format!("{OFFICIAL_ORIGIN}/base.swf"))
        .send()
        .await
    {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => return internal(error),
            },
            Err(error) => return internal(error),
        },
        Err(error) => return internal(error),
    };
    let sha256 = hex::encode(Sha256::digest(&official));
    let cached = CachedBase {
        sha256,
        bytes: Arc::new(official.to_vec()),
    };
    tracing::info!(
        sha256 = %cached.sha256,
        bytes = cached.bytes.len(),
        "cached byte-identical current base"
    );
    *state.official_base.write().await = Some(cached.clone());
    swf_response(cached)
}

fn swf_response(cached: CachedBase) -> Response {
    let mut response = Body::from(cached.bytes.as_ref().clone()).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-shockwave-flash"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-shararam-base-sha256",
        HeaderValue::from_str(&cached.sha256).unwrap(),
    );
    response
}

async fn socket_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TunnelQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    state.diagnostics.write().await.websocket_requests += 1;
    if query.cap != state.capability() || !valid_origin(&state, &headers) {
        return forbidden();
    }
    let Some(session) = session(&state, &headers).await else {
        tracing::info!("bridge WebSocket rejected: no local session");
        return (StatusCode::UNAUTHORIZED, "Login required").into_response();
    };
    let endpoint = {
        let servers = session.servers.read().await;
        servers
            .values()
            .find(|endpoint| {
                tunnel::endpoint_target(endpoint).is_ok_and(|(host, port)| {
                    host.eq_ignore_ascii_case(&query.host) && port == query.port
                })
            })
            .cloned()
    };
    let Some(endpoint) = endpoint else {
        tracing::info!("socket tunnel rejected: target is absent from fresh ServerAction");
        return forbidden();
    };
    if session
        .tunnel_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            "This session already has an active socket tunnel",
        )
            .into_response();
    }
    tracing::info!(host = %query.host, port = query.port, "opaque socket tunnel accepted");
    let diagnostics = state.diagnostics.clone();
    let tunnel_active = session.tunnel_active.clone();
    ws.on_upgrade(move |socket| async move {
        tunnel::run(socket, endpoint, diagnostics).await;
        tunnel_active.store(false, Ordering::Release);
    })
}

async fn official_proxy(
    State(state): State<AppState>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    state.diagnostics.write().await.proxy_requests += 1;
    tracing::debug!(method = %method, path = %path, "official proxy request");
    if request.method() != Method::GET
        && request.method() != Method::HEAD
        && !valid_origin(&state, request.headers())
    {
        return forbidden();
    }
    let Some(session) = session(&state, request.headers()).await else {
        tracing::info!(method = %method, path = %path, "official proxy rejected: no local session");
        return (StatusCode::UNAUTHORIZED, "Login required").into_response();
    };
    if path.contains("..") || path.starts_with('/') {
        return forbidden();
    }
    let query = request
        .uri()
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    let url = format!("{OFFICIAL_ORIGIN}/{path}{query}");
    let request_headers = request.headers().clone();
    let body = match to_bytes(request.into_body(), 16 * 1024 * 1024).await {
        Ok(body) => body,
        Err(error) => return internal(error),
    };
    let referer = session
        .swf_url
        .read()
        .await
        .clone()
        .unwrap_or_else(|| format!("{OFFICIAL_ORIGIN}/base.swf"));
    let upstream_method = match wreq_transport::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(method) => method,
        Err(error) => return internal(error),
    };
    let mut upstream = session
        .client
        .request(upstream_method, url)
        .header("Origin", OFFICIAL_ORIGIN)
        .header("Referer", referer);
    for name in [
        header::ACCEPT,
        header::ACCEPT_LANGUAGE,
        header::CONTENT_TYPE,
        header::RANGE,
    ] {
        if let Some(value) = request_headers
            .get(&name)
            .and_then(|value| value.to_str().ok())
        {
            upstream = upstream.header(name.as_str(), value);
        }
    }
    if let Some(value) = request_headers
        .get("X-Requested-With")
        .and_then(|value| value.to_str().ok())
    {
        upstream = upstream.header("X-Requested-With", value);
    }
    if method != Method::GET && method != Method::HEAD {
        upstream = upstream.body(body);
    }
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(error) => return internal(error),
    };
    let status = match StatusCode::from_u16(upstream.status().as_u16()) {
        Ok(status) => status,
        Err(error) => return internal(error),
    };
    let response_headers = official_response_headers(upstream.headers());
    if path.eq_ignore_ascii_case("async/ServerAction") {
        let bytes = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => return internal(error),
        };
        if let Ok(xml) = std::str::from_utf8(&bytes) {
            session.remember_servers(xml).await;
        }
        let server_count = session.servers.read().await.len();
        state.diagnostics.write().await.server_count = server_count;
        tracing::info!(
            method = %method,
            path = %path,
            status = %status,
            bytes = bytes.len(),
            server_count,
            "official bootstrap response"
        );
        return proxy_response(status, &response_headers, Body::from(bytes));
    }
    tracing::debug!(
        method = %method,
        path = %path,
        status = %status,
        "official proxy response headers"
    );
    let body = streaming_proxy_body(upstream.bytes_stream());
    proxy_response(status, &response_headers, body)
}

fn streaming_proxy_body<S, E>(upstream: S) -> Body
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::fmt::Display + Send + Sync + 'static,
{
    Body::from_stream(
        upstream.map(|item| item.map_err(|error| std::io::Error::other(error.to_string()))),
    )
}

fn official_response_headers(source: &wreq_transport::header::HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
    ] {
        if let Some(value) = source.get(name.as_str())
            && let Ok(value) = HeaderValue::from_bytes(value.as_bytes())
        {
            headers.insert(name, value);
        }
    }
    headers
}

fn proxy_response(status: StatusCode, source: &HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
    ] {
        if let Some(value) = source.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    response
}

async fn session(state: &AppState, headers: &HeaderMap) -> Option<OfficialSession> {
    let id = session_id(headers)?;
    state.sessions.read().await.get(id).cloned()
}

fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("shlive_session="))
}

fn valid_capability_header(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("x-shararam-live-capability")
        .and_then(|v| v.to_str().ok())
        == Some(state.capability())
}

fn valid_origin(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    // Public mode: the reverse proxy terminates TLS for the configured host and
    // forwards both Host and Origin unchanged, so require an exact HTTPS match.
    if let Some(public_host) = state.public_host() {
        return host == public_host && origin == format!("https://{public_host}");
    }
    (host.starts_with("127.0.0.1:") || host.starts_with("localhost:"))
        && origin == format!("http://{host}")
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "Forbidden").into_response()
}
fn internal(error: impl std::fmt::Display) -> Response {
    tracing::warn!("HTTP bridge failure: {error}");
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(json!({"error": error.to_string()})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt, stream};
    use std::{collections::HashMap, net::Ipv4Addr, sync::Arc, time::Duration};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::{
        Message as ClientMessage, client::IntoClientRequest, http::HeaderValue as ClientHeaderValue,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn csp_allows_ruffle_shadow_dom_styles_but_not_inline_scripts() {
        let response = router(AppState::new().unwrap())
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let csp = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("style-src 'self' 'unsafe-inline'"));
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
        assert!(csp.contains("connect-src 'self' ws://127.0.0.1:* ws://localhost:*"));
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[tokio::test]
    async fn public_mode_csp_points_the_socket_tunnel_at_the_external_host() {
        let response = router(AppState::with_public_host("shararam.sadfun.dev").unwrap())
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let csp = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' wss://shararam.sadfun.dev"));
        assert!(!csp.contains("127.0.0.1"));
        assert!(!csp.contains("ws://"));
    }

    #[tokio::test]
    async fn served_index_carries_the_capability_and_never_the_placeholder() {
        let state = AppState::with_public_host("shararam.sadfun.dev").unwrap();
        let capability = state.capability().to_owned();
        let response = router(state)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains(&format!("content=\"{capability}\"")));
        assert!(!body.contains(CAPABILITY_PLACEHOLDER));
    }

    #[test]
    fn public_origin_check_requires_the_external_https_origin() {
        let state = AppState::with_public_host("shararam.sadfun.dev").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("shararam.sadfun.dev"),
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://shararam.sadfun.dev"),
        );
        assert!(valid_origin(&state, &headers));

        // A stale loopback origin must not be accepted once the server is public.
        let mut loopback = HeaderMap::new();
        loopback.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8787"));
        loopback.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:8787"),
        );
        assert!(!valid_origin(&state, &loopback));

        // A cross-site origin with a spoofed Host is rejected.
        let mut spoofed = HeaderMap::new();
        spoofed.insert(
            header::HOST,
            HeaderValue::from_static("shararam.sadfun.dev"),
        );
        spoofed.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.test"),
        );
        assert!(!valid_origin(&state, &spoofed));
    }

    #[tokio::test]
    async fn public_status_does_not_leak_server_diagnostics() {
        let state = AppState::with_public_host("shararam.sadfun.dev").unwrap();
        let capability = state.capability().to_owned();
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/status")
                    .header("x-shararam-live-capability", capability)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains("\"authenticated\""));
        assert!(!body.contains("diagnostics"));
    }

    #[tokio::test]
    async fn expired_official_session_returns_unauthorized_and_is_removed() {
        let upstream = Router::new()
            .route(
                "/game",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/login")]) }),
            )
            .route("/login", get(|| async { "official login page" }));
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let state = AppState::with_public_host("shararam.sadfun.dev").unwrap();
        let capability = state.capability().to_owned();
        state.sessions.write().await.insert(
            "expired-session".to_owned(),
            OfficialSession {
                client: wreq_transport::Client::builder()
                    .redirect(wreq_transport::redirect::Policy::limited(5))
                    .build()
                    .unwrap(),
                servers: Default::default(),
                swf_url: Default::default(),
                tunnel_active: Default::default(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-shararam-live-capability",
            HeaderValue::from_str(&capability).unwrap(),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("shlive_session=expired-session"),
        );

        let response = bootstrap_from_origin(state.clone(), headers, &origin).await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(state.sessions.read().await.is_empty());
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.contains("Max-Age=0"));
        assert!(cookie.contains("Secure"));
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("Сессия истекла"));

        server.abort();
    }

    #[test]
    fn only_redirects_to_the_official_login_are_treated_as_expired() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::LOCATION,
            HeaderValue::from_static("https://www.shararam.ru/login?returnUrl=%2Fgame"),
        );
        assert!(is_login_redirect(StatusCode::FOUND, &headers));
        assert!(!is_login_redirect(StatusCode::OK, &headers));

        headers.insert(header::LOCATION, HeaderValue::from_static("/maintenance"));
        assert!(!is_login_redirect(StatusCode::TEMPORARY_REDIRECT, &headers));
    }

    #[test]
    fn embedded_flash_server_urls_keep_the_required_trailing_slash() {
        let app = WebAssets::get("app.js").unwrap();
        let source = std::str::from_utf8(&app.data).unwrap();
        assert!(source.contains("const localOfficial = `${location.origin}/official/`"));
        assert!(source.contains("game_server: localOfficial"));
        assert!(source.contains("url_path_server: localOfficial"));
        assert!(source.contains("portal_url: localOfficial"));
        assert!(source.contains("manual_server_selection: \"1\""));
    }

    #[test]
    fn official_flashvars_are_preserved_for_the_current_desktop_client() {
        let page = r#"<embed flashvars="game_server=https%3A%2F%2Fwww.shararam.ru%2F&amp;url_path_server=https%3A%2F%2Fwww.shararam.ru%2F&amp;portal_url=https%3A%2F%2Fwww.shararam.ru%2F&amp;start_step=0&amp;manual_server_selection=&amp;domainId=1&amp;useHashInName=true&amp;splcid=SP123&amp;client=1">"#;
        let parameters = parse_official_flashvars(page).unwrap();
        assert_eq!(parameters.get("client").map(String::as_str), Some("1"));
        assert_eq!(
            parameters.get("useHashInName").map(String::as_str),
            Some("true")
        );
        assert_eq!(parameters.get("splcid").map(String::as_str), Some("SP123"));
        assert_eq!(
            parameters.get("game_server").map(String::as_str),
            Some("https://www.shararam.ru/")
        );

        let current_page = r#"
            <script>
                window.opt = {
                    urlGameSwfFiles: "https://www.shararam.ru/",
                    urlGameServer: "https://www.shararam.ru/",
                    domainId: 1,
                    splcid: "SP400712910",
                    client: 1,
                    useHashInName: true,
                    gameStartStep: 0,
                    gameStartAction: undefined,
                    gameReferalName: undefined,
                    version: 5364237
                };
            </script>
        "#;
        let parameters = parse_official_flashvars(current_page).unwrap();
        assert_eq!(parameters.get("client").map(String::as_str), Some("1"));
        assert_eq!(
            parameters.get("useHashInName").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            parameters.get("splcid").map(String::as_str),
            Some("SP400712910")
        );
        assert!(!parameters.contains_key("start_action"));
        assert!(!parameters.contains_key("referalName"));
        assert_eq!(
            official_swf_url(current_page).unwrap(),
            "https://www.shararam.ru/base.swf?v=5364237"
        );
    }

    #[test]
    fn browser_path_uses_original_swf_and_rtmp_ruffle() {
        let index = WebAssets::get("index.html").unwrap();
        let index = std::str::from_utf8(&index.data).unwrap();
        assert!(index.contains("/ruffle/ruffle.js"));

        let app = WebAssets::get("app.js").unwrap();
        let app = std::str::from_utf8(&app.data).unwrap();
        assert!(app.contains("swfUrl: \"/game/base.swf\""));
        assert!(app.contains("originalSwfUrl: bootstrap.swfUrl"));
        assert!(app.contains("spoofUrl: originalSwfUrl"));
        assert!(app.contains("pageUrl: \"https://www.shararam.ru/game\""));
        assert!(app.contains("playerVersion: [23, 0, 0, 162]"));
        assert!(app.contains("socketProxy: [{"));
        assert!(app.contains("/socket-proxy?cap="));
        assert!(app.contains("await importNativeSharedObject()"));
        assert!(app.contains("localStorage.setItem(key, btoa(binary))"));
        assert!(app.contains("player?.ReconnectDisable?.()"));
        assert!(app.contains("window.addEventListener(\"beforeunload\""));
        assert!(app.contains("cause.status === 401"));
        assert!(app.contains("login.hidden = false"));
        assert!(app.contains("form.querySelector(\"button\").disabled = false"));
    }

    #[test]
    fn the_player_is_fitted_to_the_stage_so_ruffle_draws_no_black_bars() {
        let app = WebAssets::get("app.js").unwrap();
        let app = std::str::from_utf8(&app.data).unwrap();
        // 815x495 is the stage of the official base.swf. Measuring the real
        // container box keeps this correct where viewport units were not.
        assert!(app.contains("const STAGE_WIDTH = 815;"));
        assert!(app.contains("const STAGE_HEIGHT = 495;"));
        assert!(app.contains("Math.min(box.width / STAGE_WIDTH, box.height / STAGE_HEIGHT)"));
        assert!(app.contains(r#"window.addEventListener("resize", fitPlayerToStage)"#));
        assert!(!app.contains(r#"player.style.width = "100%""#));

        // Match the official page: its 1px-wide shgrd.png is stretched behind
        // the Flash stage, rather than deriving a background from game pixels.
        assert!(!app.contains("getImageData"));
        let styles = WebAssets::get("styles.css").unwrap();
        let styles = std::str::from_utf8(&styles.data).unwrap();
        assert!(styles.contains("url(\"/shgrd.png\") center / 100% 100% no-repeat"));
        assert!(WebAssets::get("shgrd.png").is_some());

        let config = WebAssets::get("ruffle-config.js").unwrap();
        let config = std::str::from_utf8(&config.data).unwrap();
        assert!(config.contains("letterbox: \"on\""));
    }

    #[test]
    fn a_software_renderer_gets_a_hardware_acceleration_notice() {
        let index = WebAssets::get("index.html").unwrap();
        let index = std::str::from_utf8(&index.data).unwrap();
        assert!(index.contains(r#"id="accel-note""#));
        assert!(index.contains("chrome://settings/system"));

        let app = WebAssets::get("app.js").unwrap();
        let app = std::str::from_utf8(&app.data).unwrap();
        assert!(app.contains("WEBGL_debug_renderer_info"));
        assert!(app.contains("swiftshader|llvmpipe|softpipe|basic render|software"));
    }

    #[tokio::test]
    async fn logout_drops_the_session_and_expires_the_cookie() {
        let state = AppState::new().unwrap();
        let capability = state.capability().to_owned();
        state.sessions.write().await.insert(
            "live-session".to_owned(),
            OfficialSession {
                client: wreq_transport::Client::new(),
                servers: Default::default(),
                swf_url: Default::default(),
                tunnel_active: Default::default(),
            },
        );

        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/logout")
                    .header("x-shararam-live-capability", &capability)
                    .header(header::COOKIE, "shlive_session=live-session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.contains("Max-Age=0"));
        assert!(
            state.sessions.read().await.is_empty(),
            "the official session must not survive a logout"
        );
    }

    #[test]
    fn hosted_visitors_are_pointed_at_the_desktop_build() {
        let index = WebAssets::get("index.html").unwrap();
        let index = std::str::from_utf8(&index.data).unwrap();
        assert!(index.contains("https://github.com/sadfun/shararam-ruffle"));
        assert!(index.contains(r#"id="hosted-note""#));
        assert!(index.contains("<title>Шарарам Ruffle</title>"));
        assert!(index.contains(r#"<link rel="icon" href="/favicon.ico" sizes="any">"#));
        assert!(WebAssets::get("favicon.ico").is_some());

        let app = WebAssets::get("app.js").unwrap();
        let app = std::str::from_utf8(&app.data).unwrap();
        // The note must stay hidden for the desktop and local-server builds.
        assert!(
            app.contains(
                r#"["127.0.0.1", "localhost", "::1", "[::1]"].includes(location.hostname)"#
            )
        );
        assert!(
            app.contains(r#"if (!loopback) document.getElementById("hosted-note").hidden = false"#)
        );
    }

    #[test]
    fn native_shared_object_path_preserves_the_flash_origin_namespace() {
        let root = PathBuf::from("profile").join("random-flash-id");
        assert_eq!(
            native_shared_object_path(&root),
            root.join("www.shararam.ru")
                .join("base.swf")
                .join("shararam.v.3.sol")
        );
    }

    #[tokio::test]
    async fn official_resource_body_is_forwarded_before_upstream_finishes() {
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let upstream = stream::unfold(receiver, |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|bytes| (Ok::<Bytes, std::io::Error>(bytes), receiver))
        });
        let body = streaming_proxy_body(upstream);
        let mut downstream = body.into_data_stream();

        sender.send(Bytes::from_static(b"first")).await.unwrap();
        let first = tokio::time::timeout(Duration::from_millis(250), downstream.next())
            .await
            .expect("the first chunk must not wait for the complete upstream body")
            .unwrap()
            .unwrap();
        assert_eq!(first, "first");
        assert!(
            tokio::time::timeout(Duration::from_millis(25), downstream.next())
                .await
                .is_err(),
            "the downstream body must remain open between upstream chunks"
        );

        sender.send(Bytes::from_static(b"second")).await.unwrap();
        drop(sender);
        let second = downstream.next().await.unwrap().unwrap();
        assert_eq!(second, "second");
        assert!(downstream.next().await.is_none());
    }

    #[tokio::test]
    async fn socket_proxy_is_one_bidirectional_opaque_byte_stream() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            let mut buffer = [0u8; 8192];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                stream.write_all(&buffer[..count]).await.unwrap();
            }
        });

        let state = AppState::new().unwrap();
        let session_id = "opaque-test-session";
        state.sessions.write().await.insert(
            session_id.to_owned(),
            OfficialSession {
                client: wreq_transport::Client::new(),
                servers: Arc::new(tokio::sync::RwLock::new(HashMap::from([(
                    7,
                    format!("rtmp://127.0.0.1:{upstream_port}/untouched/path"),
                )]))),
                swf_url: Default::default(),
                tunnel_active: Default::default(),
            },
        );
        let capability = state.capability().to_owned();
        let diagnostics = state.diagnostics.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router(state)).await });

        let url = format!(
            "ws://{address}/socket-proxy?cap={capability}&host=127.0.0.1&port={upstream_port}"
        );
        let denied_url = format!(
            "ws://{address}/socket-proxy?cap={capability}&host=127.0.0.2&port={upstream_port}"
        );
        let mut denied = denied_url.as_str().into_client_request().unwrap();
        denied.headers_mut().insert(
            "origin",
            ClientHeaderValue::from_str(&format!("http://{address}")).unwrap(),
        );
        denied.headers_mut().insert(
            "cookie",
            ClientHeaderValue::from_str(&format!("shlive_session={session_id}")).unwrap(),
        );
        match tokio_tungstenite::connect_async(denied)
            .await
            .expect_err("a target absent from ServerAction must be rejected")
        {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            other => panic!("unexpected unapproved target error: {other:?}"),
        }

        let mut request = url.as_str().into_client_request().unwrap();
        request.headers_mut().insert(
            "origin",
            ClientHeaderValue::from_str(&format!("http://{address}")).unwrap(),
        );
        request.headers_mut().insert(
            "cookie",
            ClientHeaderValue::from_str(&format!("shlive_session={session_id}")).unwrap(),
        );
        let (mut websocket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        let mut duplicate = url.as_str().into_client_request().unwrap();
        duplicate.headers_mut().insert(
            "origin",
            ClientHeaderValue::from_str(&format!("http://{address}")).unwrap(),
        );
        duplicate.headers_mut().insert(
            "cookie",
            ClientHeaderValue::from_str(&format!("shlive_session={session_id}")).unwrap(),
        );
        let duplicate_error = tokio_tungstenite::connect_async(duplicate)
            .await
            .expect_err("a second WebSocket for one session must be rejected");
        match duplicate_error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::CONFLICT);
            }
            other => panic!("unexpected duplicate tunnel error: {other:?}"),
        }

        let payload: Vec<u8> = (0..196_731)
            .map(|index| ((index * 131 + 17) & 0xff) as u8)
            .collect();
        websocket
            .send(ClientMessage::Binary(payload[..17].to_vec().into()))
            .await
            .unwrap();
        websocket
            .send(ClientMessage::Binary(payload[17..65_543].to_vec().into()))
            .await
            .unwrap();
        websocket
            .send(ClientMessage::Binary(payload[65_543..].to_vec().into()))
            .await
            .unwrap();

        let echoed = tokio::time::timeout(Duration::from_secs(5), async {
            let mut echoed = Vec::with_capacity(payload.len());
            while echoed.len() < payload.len() {
                match websocket.next().await.unwrap().unwrap() {
                    ClientMessage::Binary(bytes) => echoed.extend_from_slice(&bytes),
                    other => panic!("unexpected WebSocket message: {other:?}"),
                }
            }
            echoed
        })
        .await
        .unwrap();
        assert_eq!(echoed, payload);

        websocket.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if diagnostics.read().await.tunnel_closes == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let diagnostics = diagnostics.read().await;
        assert_eq!(diagnostics.tunnel_connections, 1);
        assert_eq!(diagnostics.browser_to_tcp_bytes, payload.len() as u64);
        assert_eq!(diagnostics.tcp_to_browser_bytes, payload.len() as u64);
        assert!(!diagnostics.tunnel_active);
        assert!(diagnostics.last_tunnel_error.is_none());
        drop(diagnostics);

        server.abort();
        echo.await.unwrap();
    }
}
