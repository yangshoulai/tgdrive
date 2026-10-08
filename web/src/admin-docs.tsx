import { DocsPage } from "./docs/docs";
import { ADMIN_DOC_PAGES } from "./docs/docs-admin-content";
import { DOC_PAGES } from "./docs/docs-content";

/** 管理员会话通过后由 /api/admin/v1/docs-bundle.js 挂载。 */
export function AdminDocsPage() {
  const basePath = window.location.pathname.startsWith("/admin") ? "/admin/docs" : "/docs";
  return <DocsPage pages={[...DOC_PAGES, ...ADMIN_DOC_PAGES]} basePath={basePath} />;
}
