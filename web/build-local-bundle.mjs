import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const source = path.join(root, "web", "src");
const dist = process.env.TGDRIVE_DIST || "/private/tmp/tgdrive-web-dist";
const assets = path.join(dist, "assets");
const vendor = path.join(dist, "vendor");
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(vendor, { recursive: true });

const compilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.React,
  jsxFactory: "React.createElement",
  esModuleInterop: true,
  removeComments: false,
};
function transpile(file) {
  return ts.transpileModule(fs.readFileSync(path.join(source, file), "utf8"), {
    compilerOptions,
    fileName: file,
  }).outputText;
}
function stripImports(code) {
  return code
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/\/\*[^]*?\*\//g, (comment) => comment);
}
const api = stripImports(transpile("api.ts"));
const apiNames = [
  "setCsrf", "login", "adminLogin", "logout", "me", "restoreUserSession", "listFiles", "makeFolder",
  "uploadFile", "deleteFiles", "moveFile", "copyFile", "contentUrl", "adminContentUrl", "adminStatus",
  "restoreAdminSession", "adminUnlock", "adminLock", "adminUsers", "createAdminUser", "setAdminUserStatus",
  "adminClients", "setAdminClientStatus", "disableAdminKey", "adminBots", "createAdminBot", "setAdminBotStatus",
  "adminObjects", "runAdminGc", "runAdminScrub", "userClients", "createUserClient", "disableUserKey",
];
const app = stripImports(transpile("App.tsx"));
const main = `const React = window.React;\nconst { StrictMode, useEffect, useMemo, useState } = React;\nconst react_1 = React;\n${api}\nconst api = { ${apiNames.join(", ")} };\n${app}\nconst ReactDOM = window.ReactDOM;\ntry { ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(StrictMode, null, React.createElement(App))); } catch (error) { document.body.innerText = String(error && error.stack || error); }\n`;
fs.writeFileSync(path.join(assets, "bundle.js"), main);
fs.writeFileSync(path.join(assets, "styles.css"), fs.readFileSync(path.join(source, "styles.css")));

const reactUmd = path.join(root, "web", "node_modules", "react", "umd", "react.development.js");
const reactDomUmd = path.join(root, "web", "node_modules", "react-dom", "umd", "react-dom.development.js");
if (!fs.existsSync(path.join(vendor, "react.umd.js"))) fs.copyFileSync(reactUmd, path.join(vendor, "react.umd.js"));
if (!fs.existsSync(path.join(vendor, "react-dom.umd.js"))) fs.copyFileSync(reactDomUmd, path.join(vendor, "react-dom.umd.js"));

for (const page of ["index.html", "user.html", "admin.html", "docs.html"]) {
  const template = fs.readFileSync(path.join(root, "web", page), "utf8");
  const themed = template
    .replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, "<script src=\"/vendor/react.umd.js\"></script>\n    <script src=\"/vendor/react-dom.umd.js\"></script>\n    <script src=\"/assets/bundle.js?v=14\"></script>")
    .replace(/<\/head>/, '  <link rel="stylesheet" href="/assets/styles.css?v=9" />\n  </head>');
  fs.writeFileSync(path.join(dist, page), themed);
}
console.log(`local bundle written to ${dist}`);
