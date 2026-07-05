# Security Policy

## Supported versions

Tether MD is pre-1.0. Only the latest 0.x release receives security fixes.

| Version            | Supported |
| ------------------ | --------- |
| latest 0.x release | Yes       |
| older releases     | No        |

## Reporting a vulnerability

Use GitHub private vulnerability reporting: the Security tab on [tether-md/tether-md](https://github.com/tether-md/tether-md/security/advisories/new). Do not open public issues for security reports. You will receive an acknowledgement within 72 hours.

Tether comments carry hidden content inside otherwise ordinary .md files; `tether export` is the sanitization path, and its byte-identity is CI-tested.
