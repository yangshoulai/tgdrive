import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const root=path.dirname(new URL(import.meta.url).pathname);
const configs={
 // 整个站点是同一个应用（用户端 + 按角色显示的系统管理）；管理员文档单独打包，只能经 /api/admin/v1/docs-bundle.js 在管理员会话下获取。
 user:{entry:'user',exportName:'App',outputDir:'',runtime:true,assetPrefix:'/'},
 'admin-docs':{entry:'admin-docs',exportName:'AdminDocsPage',outputDir:'',runtime:false,assetPrefix:'/'},
};
// 单一站点：全部产物都在 dist/，由同一个服务进程托管；不带参数时全部构建。
for(const app of process.argv[2] ? [process.argv[2]] : ['user','admin-docs']) {
 const config=configs[app];
 if(!config) throw Error('未知应用');
 const modules={};
 function visit(file) {
  const id=path.relative(root,file);
  if(modules[id]) return id;
  let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText;
  modules[id]='';
  code=code.replace(/require\("([^"\n]+)"\)/g,(all,dep)=>{
   if(!dep.startsWith('.')) return all;
   let target=path.resolve(path.dirname(file),dep);
   if(!path.extname(target)) target=['.tsx','.ts'].map(ext=>target+ext).find(fs.existsSync);
   return `require(${JSON.stringify(visit(target))})`;
  });
  modules[id]=code; return id;
 }
 const entry=visit(path.join(root,'src',config.entry+'.tsx'));
 const mountId=config.runtime?'root':'admin-docs-root';
 const bundle=`(()=>{const React=window.React;const ReactDOM=window.ReactDOM;const cache={};const modules={${Object.entries(modules).map(([id,code])=>JSON.stringify(id)+':function(module,exports,require){'+code+'}').join(',')}};function require(id){if(id==='react')return window.React;if(id==='react-dom')return window.ReactDOM;if(id==='react/jsx-runtime')return {jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment};if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const Entry=require(${JSON.stringify(entry)});const App=Entry.${config.exportName};ReactDOM.createRoot(document.getElementById(${JSON.stringify(mountId)})).render(React.createElement(App));})();`;
 const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
 const hash=crypto.createHash('sha256').update(bundle+css).digest('hex').slice(0,12);
 const dist=path.join(root,'dist',config.outputDir);fs.mkdirSync(dist,{recursive:true});
 if(config.runtime) for(const old of fs.readdirSync(dist)) if(/^app-[0-9a-f]+\.(js|css)$/.test(old)) fs.unlinkSync(path.join(dist,old));
 if(!config.runtime) { fs.writeFileSync(path.join(dist,`${app}.js`),bundle); console.log(`${app}: ${dist}/${app}.js`); continue; }
 fs.writeFileSync(path.join(dist,`app-${hash}.js`),bundle);fs.writeFileSync(path.join(dist,`app-${hash}.css`),css);
 for(const [pkg,name] of [['react','react'],['react-dom','react-dom']])fs.copyFileSync(path.join(root,'node_modules',pkg,'umd',`${name}.production.min.js`),path.join(dist,`${name}.js`));
 const prefix=config.assetPrefix;
 // 品牌名与图标：名称改动请同步 src/brand.ts；图标是内联 SVG，不依赖任何外部资源。
 const title='Tessera';
 const favicon='data:image/svg+xml,'+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='#18236b'/><rect x='5' y='5' width='10' height='10' rx='2.6' fill='#fff'/><rect x='5' y='17' width='10' height='10' rx='2.6' fill='#fff' fill-opacity='.62'/><rect x='17' y='17' width='10' height='10' rx='2.6' fill='#fff' fill-opacity='.38'/><polygon points='18.3,6.3 25.7,6.3 25.7,13.7' fill='#f0a22e' stroke='#f0a22e' stroke-width='2.6' stroke-linejoin='round'/></svg>");
 fs.writeFileSync(path.join(dist,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="theme-color" content="#18236b"><link rel="icon" type="image/svg+xml" href="${favicon}"><link rel="stylesheet" href="${prefix}app-${hash}.css"></head><body><div id="root"></div><script src="${prefix}react.js"></script><script src="${prefix}react-dom.js"></script><script src="${prefix}app-${hash}.js"></script></body></html>`);
 console.log(`${app}: ${dist} (${Object.keys(modules).join(', ')})`);
}
