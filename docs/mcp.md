# Optional assistant (MCP)

TallyMed works completely without AI. This optional feature lets a program you run on your own network (an "assistant client") read a narrow set of data and **propose** that an uploaded document belongs to a bill or a visit. A signed-in person reviews every proposal in the TallyMed app. The assistant cannot approve anything, change a bill, record a payment, touch accounts or read other records. It is off unless you turn it on, and it is a separate process from the web app.

## What the assistant can and cannot do

| Tool | Scope | What it returns or does |
| --- | --- | --- |
| `list_unmatched_documents` | `documents:read` | Documents attached to nothing: id, title, kind, note, file name, media type, size, SHA-256, current version. |
| `list_records_needing_documents` | `records:read` | Bills (provider, family member, reference, dates, amount status, responsibility in cents) or visits (provider, member, date, description) with no document. |
| `read_document_content` | `documents:content` | The current version's file as an embedded resource, up to a size cap (2 MB by default), checksum-verified. |
| `propose_document_match` | `proposals:create` | Records one pending proposal (document, bill or visit, confidence, a rationale of up to 500 characters). Nothing is attached. |
| `list_my_proposals` | `proposals:create` | The client's own proposals and whether they were approved or rejected (never the reason or the reviewer). |

There is no tool to approve, reject, attach, detach, pay, refund, edit, delete or invite, and no way to run SQL. The tools a credential may not use are not even listed. All text a tool returns (titles, notes, file names, names, descriptions) and everything inside a document is untrusted data: each response says so, and none of it can change what the service does.

The listener connects to PostgreSQL as its own role, `tallymed_mcp`, which can read only the columns these tools return and can insert only proposals and audit rows (plus update its own credentials' last-used time). It cannot read accounts, sessions, payments, HSA records, free-text notes on bills, visits or adjustments, or the reasons and reviewers of decisions, and it cannot write money or documents. It can insert only pending proposals and audit rows of its own kinds (`mcp.*`, `proposal.created`, never in a person's name); the database refuses anything else. It is not scoped to one household in the database: household isolation rests on the listener's queries, which suits a single-household install. The listener checks this at startup and refuses to start if the role can do more.

## Data boundary: read this before granting `documents:content`

Everything an assistant client reads is returned to that client. If the client is a cloud AI service, or forwards what it reads to one, your bills, visit descriptions, document titles and (with `documents:content`) the files themselves leave your network. The network restrictions below protect the listener, not what the client does next. Grant `documents:content` only to a client whose provider you trust with those documents, prefer `documents:read` plus `records:read` (titles, dates, references and amounts only) where that is enough, and prefer a client that runs a model locally. Revoke a credential when you stop using the client.

## Turn it on

1. **Create the restricted database role.** With the owner `DATABASE_URL`, and a password of 24 or more characters on stdin:

   ```sh
   printf '%s' "$MCP_DB_PASSWORD" | DATABASE_URL=... npm run mcp -w @tallymed/web -- setup-role
   ```

   This creates (or updates) the role `tallymed_mcp` (set `TALLYMED_MCP_ROLE` for another name) and applies the grants. Run it again after every upgrade that adds tables (it is safe to repeat). The web image does not contain the listener code, so in a Compose stack run it from the assistant image with the owner database URL: `docker compose --profile mcp run --rm -T -e DATABASE_URL mcp node apps/web/cli/mcp.ts setup-role` after exporting `DATABASE_URL` (owner URL, `postgres://tallymed:<owner password>@db:5432/tallymed`) in your shell, so the password is passed by name and is not on the command line. For the published-image stack see [operations](operations.md).

2. **Configure the listener.** Set these on the MCP process only (never on the web service). A database password with characters such as `@`, `/` or `:` must be percent-encoded in a URL (the Compose file does not do it for you; prefer a password of letters and digits):

   | Variable | Meaning |
   | --- | --- |
   | `TALLYMED_MCP_ENABLED` | Must be exactly `true`. Anything else, or unset, and the process exits without listening. |
   | `TALLYMED_MCP_DATABASE_URL` | URL for the `tallymed_mcp` role. |
   | `TALLYMED_MCP_BIND` | A loopback or private-network interface address (default `127.0.0.1`). A wildcard, hostname or public address is refused. |
   | `TALLYMED_MCP_PORT` | Default `8765`. |
   | `TALLYMED_MCP_TLS_CERT_FILE`, `TALLYMED_MCP_TLS_KEY_FILE` | Required unless the bind is loopback. |
   | `TALLYMED_MCP_ALLOWED_CIDRS` | Required unless the bind is loopback: comma-separated addresses or CIDR blocks of the machines allowed to connect, for example `192.168.1.40,192.168.1.0/28`. `0.0.0.0/0` is refused. |
   | `TALLYMED_MCP_ALLOWED_HOSTS` | Required unless the bind is loopback: the `host:port` values clients use, for example `tallymed-mcp.lan:8765`. Any other `Host` header is refused (DNS-rebinding protection). |
   | `TALLYMED_MCP_ALLOWED_ORIGINS` | Default none. A native client sends no `Origin`; a request that carries one is refused unless listed. |
   | `TALLYMED_DOCUMENTS_DIR` | Only for `documents:content`: the document volume, mounted read-only into the MCP process. |
   | `TALLYMED_MCP_CONTENT_MAX_KB` | Cap for `read_document_content`, 1 to 8192 (default 2048). |
   | `TALLYMED_MCP_CALLS_PER_MINUTE`, `TALLYMED_MCP_FAILED_AUTH_PER_MINUTE`, `TALLYMED_MCP_PENDING_PER_CLIENT`, `TALLYMED_MCP_PENDING_PER_HOUSEHOLD` | Limits (defaults 120, 20, 50, 200). |
   | `TALLYMED_MCP_CONTAINER` | `true` only inside a container, where the process cannot know its own private address and may bind `0.0.0.0`. All other non-loopback requirements still apply. |

3. **Start it.** `npm run mcp -w @tallymed/web` (or `node apps/web/cli/mcp.ts` from the image). With Compose, set `TALLYMED_MCP_ENABLED=true`, `TALLYMED_MCP_DB_PASSWORD`, the allowlist and host names, put `tls.crt` and `tls.key` in `./.mcp-tls` (relative to the Compose file, so `deploy/.mcp-tls` for `deploy/compose.release.yaml`, or set `TALLYMED_MCP_TLS_DIR`), then `docker compose --profile mcp up -d mcp`. The default `docker compose up` never starts it. The endpoint is `POST /mcp` on the configured address (MCP streamable HTTP, stateless, JSON responses).

4. **Create a credential.** Sign in as an administrator and open **Assistant**. Name it, choose a lifetime (at most 365 days) and the permissions, and copy the token from the next page. It is shown once, only its SHA-256 digest is stored, and a lost token cannot be recovered: revoke it and make another. Up to ten credentials can be active at a time.

## Connect a client

Configure the client with the endpoint URL and the header `Authorization: Bearer <token>`. For example, with the official TypeScript SDK:

```ts
const client = new Client({ name: 'my-assistant', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://tallymed-mcp.lan:8765/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.TALLYMED_MCP_TOKEN}` } },
}));
```

Clients that only support a local stdio server can use a small bridge such as `mcp-remote` pointed at the URL with the same header. Trust the listener's certificate on the client (a private CA is fine). Keep the token in the client's secret store, not in a repository or chat.

## Network restrictions

Use all three layers; the listener enforces the first two itself and needs the third from you:

1. **Bind** to a loopback or private interface only. For the same machine use `127.0.0.1`. For a LAN use that interface's private address (or `0.0.0.0` inside a container with the published port bound to a private interface).
2. **Application allowlist and checks** (always on): the peer address must be loopback or in `TALLYMED_MCP_ALLOWED_CIDRS`; the `Host` header must be listed; an `Origin` header is refused unless listed; only `POST /mcp` is served; bodies are limited to 64 KB; repeated bad credentials from one address are refused for a minute (a valid credential from that address still works); each credential is rate limited, one request counting as one call, and a JSON-RPC batch is refused.
3. **Host firewall**: allow the MCP port only from the client machines (for example `ufw allow from 192.168.1.40 to any port 8765 proto tcp`) and deny it from everywhere else, including the Docker bridge for other containers. Inside Docker the peer address of a published port may be the bridge gateway, so the firewall and the published interface, not the application allowlist, are the real restriction there.

**Never route MCP through the web reverse proxy.** The web app's proxy publishes the browser UI only; do not add a location or upstream for the MCP port, and do not publish the port on a public interface. The listener refuses any request that carries `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via` or the web proxy's secret header, so a misrouted request fails closed, and the web app has no route to the listener or its database role. Verify from outside your network that the MCP port is closed, and that `https://<your web origin>/mcp` is a 404.

## Review proposals

Open **Proposals** (the count shows in the menu). Each proposal shows the document version, the record, the confidence, the assistant's reason (plain text) and the credential that made it. **Approve and attach** links exactly that document version to that record and is recorded with its provenance. TallyMed refuses the approval, and says why, when the document has a newer version or was removed, the record was edited since, the document is already attached there, the credential has been revoked, or the proposal was already decided. **Reject** records a reason; the assistant cannot raise the same suggestion again for that document version and record. Both are audited.

## Revoke and rotate

On **Assistant**, **Revoke** a credential with a reason. It stops working on its next request (there are no sessions to expire). Revocation cannot be undone. Proposals from a revoked credential stay visible: you can reject them, but not approve them. Rotate by creating a new credential, updating the client and revoking the old one. The reason you give is kept in the audit trail. A credential also expires on its own; a pending proposal from an expired (not revoked) credential can still be reviewed and approved by a person. If a token is exposed, revoke first, then review the audit trail (`mcp.tool_called`, `mcp.tool_refused`, `proposal.created`) for what it did.

## What is recorded

Every tool call is audited with the credential, the tool name and the outcome code only: no document text, titles, rationales or token. Creating and revoking credentials, creating, approving and rejecting proposals, and content reads are audited. Logs carry request ids and codes, never the token or document content. Failed credentials are logged by request id only.

## Verification

`tests/web/mcp.test.mjs` and `tests/web/proposals.test.mjs` cover disabled-by-default behavior, bind and allowlist validation, proxy-header, Host and Origin refusal, missing, malformed, revoked, expired and wrong credentials, scope enforcement, the database role's privileges, prompt-injection fixtures, repeated, concurrent and stale approvals, rejected proposals and the absence of any financial or privileged write. They use fabricated data and no live deployment.
