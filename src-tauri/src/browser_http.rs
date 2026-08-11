use std::io::{self, Write};
use wreq_transport::{
    Emulation, Group,
    http2::{Http2Options, PseudoId, PseudoOrder, SettingId, SettingsOrder},
    tls::{
        KeyShare, TlsOptions, TlsVersion,
        compress::{CertificateCompressionAlgorithm, CertificateCompressor, Codec},
    },
};

const CIPHER_LIST: &str = concat!(
    "TLS_AES_128_GCM_SHA256:",
    "TLS_AES_256_GCM_SHA384:",
    "TLS_CHACHA20_POLY1305_SHA256:",
    "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:",
    "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:",
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:",
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:",
    "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:",
    "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:",
    "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA:",
    "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:",
    "TLS_RSA_WITH_AES_128_GCM_SHA256:",
    "TLS_RSA_WITH_AES_256_GCM_SHA384:",
    "TLS_RSA_WITH_AES_128_CBC_SHA:",
    "TLS_RSA_WITH_AES_256_CBC_SHA"
);

const SIGNATURE_ALGORITHMS: &str = concat!(
    "ecdsa_secp256r1_sha256:",
    "rsa_pss_rsae_sha256:",
    "rsa_pkcs1_sha256:",
    "ecdsa_secp384r1_sha384:",
    "rsa_pss_rsae_sha384:",
    "rsa_pkcs1_sha384:",
    "rsa_pss_rsae_sha512:",
    "rsa_pkcs1_sha512"
);

#[derive(Debug)]
struct BrotliCertificateCompressor;

static BROTLI_CERTIFICATE_COMPRESSOR: BrotliCertificateCompressor = BrotliCertificateCompressor;

impl CertificateCompressor for BrotliCertificateCompressor {
    fn compress(&self) -> Codec {
        Codec::Pointer(|input, output| {
            let mut encoder = brotli::CompressorWriter::new(output, 4_096, 11, 22);
            encoder.write_all(input)
        })
    }

    fn decompress(&self) -> Codec {
        Codec::Pointer(|input, output| {
            let mut decoder = brotli::Decompressor::new(input, 4_096);
            io::copy(&mut decoder, output).map(|_| ())
        })
    }

    fn algorithm(&self) -> CertificateCompressionAlgorithm {
        CertificateCompressionAlgorithm::BROTLI
    }
}

/// Chromium-compatible TLS and HTTP/2 transport characteristics.
///
/// Shararam binds the RTMP ticket returned by `ServerAction` to the HTTP
/// session that requested it. A Chromium User-Agent on a generic TLS client
/// is not sufficient, so the session uses BoringSSL and Chromium's wire-level
/// settings while retaining the exact legacy Electron User-Agent separately.
pub fn chromium_profile() -> Emulation {
    let tls = TlsOptions::builder()
        .grease_enabled(true)
        .enable_ocsp_stapling(true)
        .enable_signed_cert_timestamps(true)
        .min_tls_version(TlsVersion::TLS_1_2)
        .max_tls_version(TlsVersion::TLS_1_3)
        .curves_list("X25519:P-256:P-384")
        .key_shares(vec![KeyShare::X25519])
        .cipher_list(CIPHER_LIST)
        .sigalgs_list(SIGNATURE_ALGORITHMS)
        .certificate_compressors(vec![
            &BROTLI_CERTIFICATE_COMPRESSOR as &'static dyn CertificateCompressor,
        ])
        .build();

    let settings_order = SettingsOrder::builder()
        .extend([
            SettingId::HeaderTableSize,
            SettingId::MaxConcurrentStreams,
            SettingId::InitialWindowSize,
            SettingId::MaxHeaderListSize,
        ])
        .build();
    let pseudo_order = PseudoOrder::builder()
        .extend([
            PseudoId::Method,
            PseudoId::Authority,
            PseudoId::Scheme,
            PseudoId::Path,
        ])
        .build();
    let http2 = Http2Options::builder()
        .header_table_size(65_536)
        .max_concurrent_streams(1_000)
        .initial_window_size(6_291_456)
        .initial_connection_window_size(15_728_640)
        .max_header_list_size(262_144)
        .settings_order(settings_order)
        .headers_pseudo_order(pseudo_order)
        .build();

    Emulation::builder()
        .tls_options(tls)
        .http2_options(http2)
        .build(Group::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_profile_has_tls_and_http2_options() {
        let profile = chromium_profile();
        assert!(profile.tls_options.is_some());
        assert!(profile.http2_options.is_some());
    }
}
