import fs from "node:fs";
import path from "node:path";

const deployments = [
  {
    name: "shop.yeunauan.live",
    tenant: "yeunauan",
    url: process.env.COMMERCE_MAIN_PREVIEW_URL,
    bypass: process.env.COMMERCE_MAIN_BYPASS,
    otherTenant: "yeubep",
    crossTarget: "yeubep-demo"
  },
  {
    name: "yeubep.shop",
    tenant: "yeubep",
    url: process.env.COMMERCE_SECOND_PREVIEW_URL,
    bypass: process.env.COMMERCE_SECOND_BYPASS,
    otherTenant: "yeunauan",
    crossTarget: "legacy-demo"
  }
];
const password = process.env.COMMERCE_PREVIEW_ADMIN_PASSWORD;
if (!password || deployments.some((item) => !item.url || !item.bypass)) {
  throw new Error("COMMERCE_HOSTED_GATE_ENV_REQUIRED");
}

async function api(deployment, method, body) {
  const response = await fetch(`${deployment.url}/api/courses`, {
    method,
    headers: {
      "x-vercel-protection-bypass": deployment.bypass,
      "x-admin-password": password,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, payload };
}

const results = [];
for (const deployment of deployments) {
  const list = await api(deployment, "GET");
  const targets = (Array.isArray(list.payload) ? list.payload : [])
    .filter((course) => course.lms_tenant === deployment.tenant && !course.legacy_shared_mapping)
    .map((course) => course.slug);
  const suffix = `${deployment.tenant}-${Date.now()}`;
  const self = await api(deployment, "POST", {
    slug: `preview-self-${suffix}`,
    title: `Preview self ${deployment.tenant}`,
    sales_site: deployment.tenant,
    learning_course_slug: "",
    active: false,
    is_published: false
  });
  const forgedDeployment = await api(deployment, "POST", {
    slug: `preview-forged-deployment-${suffix}`,
    title: "Forged deployment tenant",
    sales_site: deployment.otherTenant,
    learning_course_slug: ""
  });
  const forgedTarget = await api(deployment, "POST", {
    slug: `preview-forged-target-${suffix}`,
    title: "Forged cross target",
    sales_site: deployment.tenant,
    learning_course_slug: deployment.crossTarget
  });
  const duplicate = await api(deployment, "POST", {
    slug: "legacy-demo",
    title: "Duplicate fixture",
    sales_site: deployment.tenant,
    learning_course_slug: ""
  });
  const row = self.payload.data || {};
  results.push({
    storefront: deployment.name,
    tenant: deployment.tenant,
    listStatus: list.status,
    sameTenantTargets: targets,
    selfTarget: {
      status: self.status,
      lms_tenant: row.lms_tenant,
      sales_site: row.sales_site,
      effective_target: row.learning_course_slug || row.slug
    },
    forgedDeployment: {
      status: forgedDeployment.status,
      code: forgedDeployment.payload.code
    },
    forgedTarget: { status: forgedTarget.status, code: forgedTarget.payload.code },
    duplicate: { status: duplicate.status, code: duplicate.payload.code },
    deepLink: `https://www.daubepnho.store/lms-admin.html?lms=${deployment.tenant}&course=${encodeURIComponent(row.slug || "")}`
  });
}

const passed = results.every((item) =>
  item.listStatus === 200 &&
  item.sameTenantTargets.length > 0 &&
  item.selfTarget.status === 201 &&
  item.selfTarget.lms_tenant === item.tenant &&
  item.selfTarget.sales_site === item.tenant &&
  item.forgedDeployment.status === 403 &&
  item.forgedDeployment.code === "COURSE_LMS_TENANT_MISMATCH" &&
  item.forgedTarget.status === 409 &&
  item.forgedTarget.code === "CROSS_LMS_TARGET_FORBIDDEN" &&
  item.duplicate.status === 409 &&
  item.duplicate.code === "COURSE_SLUG_CONFLICT"
);
const output = path.resolve("_local_artifacts/dual-lms-preview/commerce-hosted-evidence.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ deployments: results }, null, 2)}\n`);
if (!passed) {
  console.error(JSON.stringify(results, null, 2));
  throw new Error("COMMERCE_HOSTED_GATE_FAILED");
}
console.log(JSON.stringify({ ok: true, deployments: results.length, output }));
