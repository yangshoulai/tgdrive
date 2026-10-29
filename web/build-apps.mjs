import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const previewAssets={};
// 只给按需加载的引擎（文本与媒体预览、助手输入框）使用标准打包器，主应用沿用自写打包器。
if(!process.argv[2] || process.argv[2]==='user') {
 const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
 for(const [kind,globalName,base] of [['text','TesseraTextPreview','preview-text'],['media','TesseraMediaPreview','preview-media'],['composer','TesseraComposer','composer'],['pdf','TesseraPdfPreview','preview-pdf']]) {
  const result=await build({entryPoints:[path.join(root,`src/${base}-engine.ts`)],bundle:true,write:false,
   outfile:path.join(dist,`${base}.js`),format:'iife',globalName,minify:true,target:'es2022',legalComments:'inline'});
  const hash=crypto.createHash('sha256');for(const file of result.outputFiles) hash.update(file.contents);
  // 保留已有哈希引擎文件，让已打开的页面仍能按旧清单延迟加载组件。
  const version=hash.digest('hex').slice(0,12);const assets={};
  for(const file of result.outputFiles) {
   const extension=path.extname(file.path).slice(1);const name=`${base}-${version}.${extension}`;
   fs.writeFileSync(path.join(dist,name),file.contents);assets[extension]=`/${name}`;
  }
  previewAssets[kind]=assets;
 }
 // PDF：pdf.js 的 Worker 与字符映射、标准字体、解码器按版本放在 dist/pdfjs/<版本>/，引擎按需加载时才请求。
 {
  const source=path.join(root,'node_modules/pdfjs-dist');const version=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version;
  const target=path.join(dist,'pdfjs',version);
  for(const folder of ['cmaps','standard_fonts','wasm','iccs']) if(fs.existsSync(path.join(source,folder))) fs.cpSync(path.join(source,folder),path.join(target,folder),{recursive:true});
  fs.copyFileSync(path.join(source,'build/pdf.worker.min.mjs'),path.join(target,'pdf.worker.js'));
  previewAssets.pdf={...previewAssets.pdf,worker:`/pdfjs/${version}/pdf.worker.js`,base:`/pdfjs/${version}/`};
 }
 // 浏览器本地缓存的 Service Worker（docs/client-cache-design.md）：地址固定为 /sw.js（作用域 /），服务端按 no-cache 返回。
 const worker=await build({entryPoints:[path.join(root,'src/sw/cache-worker.ts')],bundle:true,write:false,outfile:path.join(dist,'sw.js'),format:'iife',minify:true,target:'es2022'});
 fs.writeFileSync(path.join(dist,'sw.js'),worker.outputFiles[0].contents);
 const licenses=[];const seen=new Set();
 function collectLicense(name) {
  if(seen.has(name)) return;seen.add(name);
  const directory=path.join(root,'node_modules',name);const manifestPath=path.join(directory,'package.json');
  if(!fs.existsSync(manifestPath)) return;
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  for(const file of fs.readdirSync(directory).filter(file=>/^licen[cs]e(?:\.|$)/i.test(file))) {
   if(fs.statSync(path.join(directory,file)).isFile()) licenses.push(`${name} ${manifest.version}\n${fs.readFileSync(path.join(directory,file),'utf8')}`);
  }
  for(const dependency of Object.keys(manifest.dependencies||{})) collectLicense(dependency);
 }
 for(const name of ['artplayer','codemirror','@codemirror/legacy-modes','markdown-it','dompurify','pdfjs-dist']) collectLicense(name);
 fs.writeFileSync(path.join(dist,'preview-licenses.txt'),licenses.join('\n\n'));
}
const configs={
 // 整个站点是同一个应用，包含文件空间、按角色显示的系统管理与完整的公开文档。
 user:{entry:'user',exportName:'App',outputDir:'',assetPrefix:'/'},
};
// 单一站点：全部产物都在 dist/，由同一个服务进程托管；不带参数时全部构建。
for(const app of process.argv[2] ? [process.argv[2]] : ['user']) {
 const config=configs[app];
 if(!config) throw Error('未知应用');
 const modules={};
 // 用队列而不是递归遍历依赖：导入链很深时，递归叠加 TypeScript 自身的输出栈会超出调用栈上限。
 function visit(start) {
  const queue=[start];
  while(queue.length) {
   const file=queue.pop();
   const id=path.relative(root,file);
   if(id in modules) continue;
   let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText;
   code=code.replace(/require\("([^"\n]+)"\)/g,(all,dep)=>{
    if(!dep.startsWith('.')) return all;
    let target=path.resolve(path.dirname(file),dep);
    if(!path.extname(target)) target=['.tsx','.ts'].map(ext=>target+ext).find(fs.existsSync);
    queue.push(target);
    return `require(${JSON.stringify(path.relative(root,target))})`;
   });
   modules[id]=code;
  }
  return path.relative(root,start);
 }
 const entry=visit(path.join(root,'src',config.entry+'.tsx'));
 const mountId='root';
 const sourceBundle=`(()=>{const React=window.React;const ReactDOM=window.ReactDOM;const cache={};const modules={${Object.entries(modules).map(([id,code])=>JSON.stringify(id)+':function(module,exports,require){'+code+'}').join(',')}};function require(id){if(id==='react')return window.React;if(id==='react-dom')return window.ReactDOM;if(id==='react/jsx-runtime')return {jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment};if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const Entry=require(${JSON.stringify(entry)});const App=Entry.${config.exportName};ReactDOM.createRoot(document.getElementById(${JSON.stringify(mountId)})).render(React.createElement(App));})();`;
 const bundle=`window.tesseraPreviewAssets=${JSON.stringify(previewAssets)};`+sourceBundle;
 const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
 const hash=crypto.createHash('sha256').update(bundle+css).digest('hex').slice(0,12);
 const dist=path.join(root,'dist',config.outputDir);fs.mkdirSync(dist,{recursive:true});
 for(const old of fs.readdirSync(dist)) if(/^app-[0-9a-f]+\.(js|css)$/.test(old)) fs.unlinkSync(path.join(dist,old));
 fs.writeFileSync(path.join(dist,`app-${hash}.js`),bundle);fs.writeFileSync(path.join(dist,`app-${hash}.css`),css);
 // 外观主题在首帧前应用（CSP 不允许内联脚本，所以单独成文件放在 head）；存储键与解析规则需和 src/theme.ts 一致。
 const themeInit=`(()=>{let p=null;try{p=localStorage.getItem("tessera-theme")}catch{}const d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"})();`;
 const themeHash=crypto.createHash('sha256').update(themeInit).digest('hex').slice(0,12);
 for(const old of fs.readdirSync(dist)) if(/^theme-[0-9a-f]+\.js$/.test(old)) fs.unlinkSync(path.join(dist,old));
 fs.writeFileSync(path.join(dist,`theme-${themeHash}.js`),themeInit);
 for(const [pkg,name] of [['react','react'],['react-dom','react-dom']])fs.copyFileSync(path.join(root,'node_modules',pkg,'umd',`${name}.production.min.js`),path.join(dist,`${name}.js`));
 const prefix=config.assetPrefix;
 // 品牌名、标语与说明直接读取 src/brand.ts（唯一来源）；图标是内联 SVG，不依赖任何外部资源。
 const brandSource=fs.readFileSync(path.join(root,'src/brand.ts'),'utf8');
 const brandText=name=>{const match=brandSource.match(new RegExp(`export const ${name} = "([^"]+)";`));if(!match)throw new Error(`src/brand.ts 缺少 ${name}`);return match[1].replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');};
 const title=brandText('BRAND'), tagline=brandText('TAGLINE'), description=brandText('STORY');
 const socialImage=fs.readFileSync(path.join(root,'assets/social-card.png'));
 const socialHash=crypto.createHash('sha256').update(socialImage).digest('hex').slice(0,12);
 const socialPath=`${prefix}social-card-${socialHash}.png`;
 fs.writeFileSync(path.join(dist,`social-card-${socialHash}.png`),socialImage);
 // 部署地址由服务端在返回 HTML 时补全，Telegram 等爬虫无需运行 JavaScript。
 const socialMeta=`<meta name="description" content="${description}"><meta property="og:type" content="website"><meta property="og:site_name" content="${title}"><meta property="og:title" content="${title} · ${tagline}"><meta property="og:description" content="${description}"><meta property="og:locale" content="zh_CN"><meta property="og:url" content="/"><meta property="og:image" content="${socialPath}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${title}：${tagline}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title} · ${tagline}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${socialPath}"><meta name="twitter:image:alt" content="${title}：${tagline}">`;
 const favicon='data:image/svg+xml,'+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='#0b0c13'/><rect x='5' y='5' width='10' height='10' rx='2.4' fill='#fff'/><rect x='5' y='17' width='10' height='10' rx='2.4' fill='#fff' fill-opacity='.6'/><rect x='17' y='17' width='10' height='10' rx='2.4' fill='#fff' fill-opacity='.32'/><polygon points='18.2,6.2 25.8,6.2 25.8,13.8' fill='#f0a22e' stroke='#f0a22e' stroke-width='2.4' stroke-linejoin='round'/><path d='M25.1 6.9 22.2 9.8' stroke='#c27a10' stroke-width='1.1' stroke-linecap='round'/></svg>");
 fs.writeFileSync(path.join(dist,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${socialMeta}<meta name="theme-color" content="#0b0c13"><link rel="icon" type="image/svg+xml" href="${favicon}"><script src="${prefix}theme-${themeHash}.js"></script><link rel="stylesheet" href="${prefix}app-${hash}.css"></head><body><div id="root"></div><script src="${prefix}react.js"></script><script src="${prefix}react-dom.js"></script><script src="${prefix}app-${hash}.js"></script></body></html>`);
 console.log(`${app}: ${dist} (${Object.keys(modules).join(', ')})`);
}
