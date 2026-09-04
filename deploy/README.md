# Public static assets

The public deployment workflow uploads Ruffle's files to
`/opt/shararam/public/ruffle`. Files larger than 1 KiB have precompressed
Brotli (`.br`) and gzip (`.gz`) sidecars generated once by CI.

As a one-time root bootstrap, `install-ruffle-static.sh` imports
`ruffle-static.caddy` inside the existing `shararam.sadfun.dev` site block,
before its catch-all proxy handler. The result is equivalent to:

```caddyfile
shararam.sadfun.dev {
	import /opt/shararam/ruffle-static.caddy
	reverse_proxy 127.0.0.1:YOUR_EXISTING_PORT
}
```

Copy both files to `/opt/shararam`, then run the installer as root. It validates
the candidate configuration and keeps a backup before replacing the active
Caddyfile:

```sh
sudo /opt/shararam/install-ruffle-static.sh
```

After that, regular application deploys atomically replace the static directory.
Caddy serves a ready-made sidecar selected from the request's
`Accept-Encoding`; it does no per-request compression.
