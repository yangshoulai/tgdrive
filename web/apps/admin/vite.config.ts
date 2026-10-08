import { defineConfig } from "vite";
export default defineConfig({server:{port:5174,proxy:{"/api/admin/":"http://127.0.0.1:8000"}},build:{outDir:"dist"},esbuild:{jsx:"automatic"}});
