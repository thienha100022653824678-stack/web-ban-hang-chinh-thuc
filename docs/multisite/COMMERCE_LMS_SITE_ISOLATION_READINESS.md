# Commerce LMS Site Isolation — Readiness

Date: 2026-07-29
Status: **READY FOR OWNER-APPROVED PRODUCTION CANARY; not authorized**

- Baseline: `74c70268f0619d9d9a9be5e564ea60200038100c`.
- Implementation SHA: `fa84d3a347b009c01c35c7746a958bf8d7c6f1d9`.
- Protected Preview: `dpl_GaoKXoWrZBN8Lrr9MKXEKA5YMujb`,
  `https://web-ban-hang-chinh-thuc-1sltsu4zu.vercel.app`.
- Tests: 73/73; dependency audit: 0 vulnerabilities.
- Feature flag: `COMMERCE_LMS_SITE_ISOLATION_ENABLED`, default false and absent
  in Production.

Verified immutable mapping:

- `yeubep.shop` → `yeunauan`.
- `shop.yeunauan.live` → `yeubep`.

Preview proved same-site target filtering, self-target persistence, forged
cross-site rejection, slug-conflict rejection, deep link and unrelated-edit
preservation. Production read-only dry-run found zero unresolved course owner
and no required backfill.

Current rollback artifacts:

- `yeubep.shop`: `dpl_CQw9cUnnXVhXVHToSFEwkYzRd1iJ`.
- `shop.yeunauan.live`: `dpl_6ATmLb9HdttVfTmgD7LBMHGmfMka`.

The authoritative cross-component runbook, rollback, monitoring and execution
manifest are committed on
`feature/lms-admin-multisite-isolation-20260729`.

No Production deploy, promotion, merge, flag, order approval, sync or data
mutation was performed.
