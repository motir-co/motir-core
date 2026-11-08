---
'@motir/cli': patch
---

A run whose agent prints a large block of output keeps reporting to Motir (MOTIR-10705). The CLI used to send a big write as one log event of any size; the server refuses a body over 16 KiB together with the rest of its batch, and the reporter then went silent for the rest of the run, so Motir ended a hosted run as stalled fifteen minutes later while its agent was still working. Each log event now carries at most 4096 UTF-8 bytes, cut on character boundaries and after the last line break that fits. A refused batch is narrowed to the one event the server will not take, which alone is dropped with one warning line; a 5xx, network failure or exhausted rate-limit wait is retried after 1, 2 and 4 seconds and, if it persists, kept for the next flush. Reporting stops only on a refused credential, a closed or missing run, or the run's event limit, which stops events but still closes the run.
