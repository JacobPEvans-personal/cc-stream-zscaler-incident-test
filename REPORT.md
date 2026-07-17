# Incident reproduction report

## s8-critical — ✅ pass

THE CRITICAL CASE: prod + dev routes; dev pipelines contain the sampling function but DISABLED; unguarded index/sourcetype overwrite at pipeline end; clone:true is stamped on cloned events by the route but no filter references it. Staged last so KEEP=1 persists this instance.

Sent: 1000 events (index=zscaler, sourcetypes round-robin zscalernss-web, zscalernss-fw, zscalernss-dns)

| Destination | index/sourcetype | Actual | Expected |
| --- | --- | --- | --- |
| prod | zscaler/zscalernss-dns | 333 | 333 |
| prod | zscaler/zscalernss-fw | 333 | 333 |
| prod | zscaler/zscalernss-web | 334 | 334 |
| dev | zscaler_dev/zscalernss-dns:clone | 333 | 333 |
| dev | zscaler_dev/zscalernss-fw:clone | 333 | 333 |
| dev | zscaler_dev/zscalernss-web:clone | 334 | 334 |
| default | (none) | 0 | 0 |

