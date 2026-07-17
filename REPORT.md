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

## s2-incident-unguarded — ✅ pass

THE INCIDENT: dev route (Final=off, no clone marker), dev pack overwrites index/sourcetype at pipeline end, sampling OFF. If clone bleed were real, prod collapses; if Cribl clones deeply, prod stays 1000.

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

## s3a-guard-eval — ✅ pass

Support's fix: route adds clone:true to cloned events; the overwrite eval inside the dev pack runs only when clone==true.

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

## s3b-guard-route-filter — ✅ pass

Mis-scoped guard: clone==true added to the WG dev route FILTER itself. The field only exists on clones created BY this route, so the filter can never match — dev gets zero events.

Sent: 1000 events (index=zscaler, sourcetypes round-robin zscalernss-web, zscalernss-fw, zscalernss-dns)

| Destination | index/sourcetype | Actual | Expected |
| --- | --- | --- | --- |
| prod | zscaler/zscalernss-dns | 333 | 333 |
| prod | zscaler/zscalernss-fw | 333 | 333 |
| prod | zscaler/zscalernss-web | 334 | 334 |
| dev | (none) | 0 | 0 |
| default | (none) | 0 | 0 |

## s4-sampled-unguarded — ✅ pass

Pre-incident steady state: unguarded overwrite but sampling 1:10 as first dev pipeline function. Only ~10% of clones survive to dev.

Sent: 1000 events (index=zscaler, sourcetypes round-robin zscalernss-web, zscalernss-fw, zscalernss-dns)

| Destination | index/sourcetype | Actual | Expected |
| --- | --- | --- | --- |
| prod | zscaler/zscalernss-dns | 333 | 333 |
| prod | zscaler/zscalernss-fw | 333 | 333 |
| prod | zscaler/zscalernss-web | 334 | 334 |
| dev | zscaler_dev/zscalernss-dns:clone | 33 | 17–67 |
| dev | zscaler_dev/zscalernss-fw:clone | 33 | 17–67 |
| dev | zscaler_dev/zscalernss-web:clone | 34 | 17–67 |
| default | (none) | 0 | 0 |

## s5-guard-pack-routes — ✅ pass

Guard placed on the dev pack's INTERNAL route filters (sourcetype && clone==true) instead of the eval. All entrants are clones, so behavior should match s3a.

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

## s6-empty-clone-spec — ✅ pass

UI 'Add clone' left empty: clones: [{}] on the dev route (adds no fields), unguarded dev pack. Distinguishes empty-clone-spec semantics from clones: [].

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

## s7-dual-dest — ✅ pass

PROD dual destination shape (Splunk + S3): two same-filter routes, prod-a Final=off to fs-s3, prod-b Final=on to fs-prod. Both should get all 1000.

Sent: 1000 events (index=zscaler, sourcetypes round-robin zscalernss-web, zscalernss-fw, zscalernss-dns)

| Destination | index/sourcetype | Actual | Expected |
| --- | --- | --- | --- |
| prod | zscaler/zscalernss-dns | 333 | 333 |
| prod | zscaler/zscalernss-fw | 333 | 333 |
| prod | zscaler/zscalernss-web | 334 | 334 |
| s3 | zscaler/zscalernss-dns | 333 | 333 |
| s3 | zscaler/zscalernss-fw | 333 | 333 |
| s3 | zscaler/zscalernss-web | 334 | 334 |
| dev | (none) | 0 | 0 |
| default | (none) | 0 | 0 |

