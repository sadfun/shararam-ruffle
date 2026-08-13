use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicBool},
};
use tokio::sync::RwLock;
use wreq_transport::{Client, StatusCode};

pub const OFFICIAL_ORIGIN: &str = "https://www.shararam.ru";
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Shararam/2.0.6 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36";

#[derive(Clone)]
pub struct OfficialSession {
    pub client: Client,
    pub servers: Arc<RwLock<HashMap<u32, String>>>,
    pub swf_url: Arc<RwLock<Option<String>>>,
    pub tunnel_active: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub login: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResult {
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
struct OfficialLoginResponse {
    code: i64,
    #[serde(default)]
    error: Option<String>,
}

impl OfficialSession {
    pub async fn login(official_origin: &str, login: &str, password: &str) -> Result<Self> {
        if login.trim().is_empty() || password.is_empty() {
            bail!("Введите логин и пароль");
        }
        // ServerAction issues an RTMP ticket bound to the browser-like HTTP
        // session that requested it. Use a real Chromium TLS/HTTP2 profile for
        // the entire cookie jar; changing only User-Agent is insufficient.
        let client = Client::builder()
            .emulation(crate::browser_http::chromium_profile())
            .cookie_store(true)
            .user_agent(USER_AGENT)
            .redirect(wreq_transport::redirect::Policy::limited(5))
            .build()?;

        client
            .get(format!("{official_origin}/login"))
            .send()
            .await
            .context("официальная страница входа недоступна")?
            .error_for_status()
            .context("официальная страница входа вернула ошибку")?;

        let password_hash = format!("{:x}", md5::compute(password.as_bytes()));
        let body =
            serde_json::json!({ "login": login.trim(), "password": password_hash }).to_string();
        let response = client
            .post(format!("{official_origin}/api/user/loqin"))
            .header("Origin", official_origin)
            .header("Referer", format!("{official_origin}/login"))
            .header("X-Requested-With", "XMLHttpRequest")
            .header(
                "Content-Type",
                "application/x-www-form-urlencoded; charset=UTF-8",
            )
            .body(body)
            .send()
            .await
            .context("официальный сервер авторизации недоступен")?;
        if response.status() != StatusCode::OK {
            bail!("официальный сервер входа вернул HTTP {}", response.status());
        }
        let result: OfficialLoginResponse = response
            .json()
            .await
            .context("неожиданный ответ сервера входа")?;
        if result.code != 0 {
            bail!(
                "{}",
                result
                    .error
                    .unwrap_or_else(|| "Неверный логин или пароль".into())
            );
        }
        Ok(Self {
            client,
            servers: Default::default(),
            swf_url: Default::default(),
            tunnel_active: Default::default(),
        })
    }

    pub async fn remember_servers(&self, xml: &str) {
        let item = Regex::new(r#"(?i)<item\b([^>]*)/?>"#).expect("static regex");
        let attr = Regex::new(r#"([\w:]+)="([^"]*)""#).expect("static regex");
        let mut servers = self.servers.write().await;
        for capture in item.captures_iter(xml) {
            let values: HashMap<_, _> = attr
                .captures_iter(&capture[1])
                .map(|pair| (pair[1].to_string(), xml_unescape(&pair[2])))
                .collect();
            if let (Some(id), Some(url)) = (
                values.get("Id").and_then(|v| v.parse().ok()),
                values.get("RTMPUrl"),
            ) && url.starts_with("rtmp://")
            {
                servers.insert(id, url.clone());
            }
        }
    }
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
