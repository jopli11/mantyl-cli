# Security

Mantyl reads private coding-agent transcripts and runs delivered code in
a sandbox, so security reports get priority attention.

To report a vulnerability, email joelparfitt@qzee.app with "SECURITY"
in the subject line. Include steps to reproduce and, if it concerns
redaction, a description of the credential shape that leaked without
including a real credential. You will get an acknowledgement within 72
hours. Please do not open a public issue for anything exploitable until
it has been addressed.

In scope: secret redaction bypasses (a credential shape that survives
into any artefact), sandbox escapes or network access during
verification, passport digest or signature verification bypasses in
`mantyl receive`, and path traversal in the session-store adapters.

There is no bounty programme. Reports are credited in the changelog if
you want the credit.
