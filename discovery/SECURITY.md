# Security Policy

## Security model

AI Sanitizer is a local-first desktop application.

Original text, restored text, mappings and local-AI prompts must remain on the user's device. The application must not provide cloud processing, remote telemetry or external crash reporting.

Local-first processing reduces exposure but does not guarantee zero risk.

## Sensitive repository content

Never commit:

- Customer or employer names
- Original customer documents
- Real sanitization mappings
- Personal data
- Credentials or secrets
- Private keys or certificates
- Local SQLite databases
- Local AI models
- Application logs containing user content
- Screenshots containing real data

Tests, examples, screenshots and documentation must use synthetic data.

## Reporting vulnerabilities

Report vulnerabilities privately to the repository owner.

Do not create a public issue containing credentials, personal data, customer information, original documents or mapping values.

Whenever possible, provide a synthetic reproduction.

## Network restrictions

The application must deny outbound processing by default.

The only permitted AI endpoint is a user-configured loopback address, such as `127.0.0.1`, for a local model runtime.

Original, sanitized and restored text must never be included in analytics, telemetry, crash reports or update checks.
