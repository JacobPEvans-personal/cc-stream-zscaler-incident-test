# Incident reproduction report

## s1-baseline — ✅ pass

PROD only, no dev route. Control: 1000 in, 1000 out to prod untouched.

Sent: 1000 events (index=zscaler, sourcetypes round-robin zscalernss-web, zscalernss-fw, zscalernss-dns)

| Destination | index/sourcetype | Actual | Expected |
| --- | --- | --- | --- |
| prod | zscaler/zscalernss-dns | 333 | 333 |
| prod | zscaler/zscalernss-fw | 333 | 333 |
| prod | zscaler/zscalernss-web | 334 | 334 |
| dev | (none) | 0 | 0 |
| default | (none) | 0 | 0 |

