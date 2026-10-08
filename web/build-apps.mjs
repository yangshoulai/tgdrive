import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const root=path.dirname(new URL(import.meta.url).pathname);
const configs={
 user:{entry:'user',exportName:'UserApp',outputDir:'user',runtime:true,assetPrefix:'/'},
 admin:{entry:'admin',exportName:'AdminRoute',outputDir:'admin',runtime:true,assetPrefix:'/'},
 'admin-docs':{entry:'admin-docs',exportName:'AdminDocsPage',outputDir:'admin',runtime:false,assetPrefix:'/admin/'},
};
for(const app of process.argv[2] ? [process.argv[2]] : ['user','admin']) {
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
 const bundle=`(()=>{const React=window.React;const ReactDOM=window.ReactDOM;const cache={};const modules={${Object.entries(modules).map(([id,code])=>JSON.stringify(id)+':function(module,exports,require){'+code+'}').join(',')}};function require(id){if(id==='react')return window.React;if(id==='react/jsx-runtime')return {jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment};if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const Entry=require(${JSON.stringify(entry)});const App=Entry.${config.exportName};ReactDOM.createRoot(document.getElementById(${JSON.stringify(mountId)})).render(React.createElement(App));})();`;
 const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
 const hash=crypto.createHash('sha256').update(bundle+css).digest('hex').slice(0,12);
 const dist=path.join(root,'apps',config.outputDir,'dist');fs.mkdirSync(dist,{recursive:true});
 if(!config.runtime) { fs.writeFileSync(path.join(dist,`${app}.js`),bundle); console.log(`${app}: ${dist}/${app}.js`); continue; }
 fs.writeFileSync(path.join(dist,`app-${hash}.js`),bundle);fs.writeFileSync(path.join(dist,`app-${hash}.css`),css);
 for(const [pkg,name] of [['react','react'],['react-dom','react-dom']])fs.copyFileSync(path.join(root,'node_modules',pkg,'umd',`${name}.production.min.js`),path.join(dist,`${name}.js`));
 // 默认站点从根路径提供；容器把管理端挂在 /admin/ 时通过环境变量调整资源前缀。
 const prefix=process.env.TGDRIVE_ASSET_PREFIX || config.assetPrefix;
 fs.writeFileSync(path.join(dist,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tgdrive</title><link rel="stylesheet" href="${prefix}app-${hash}.css"></head><body><div id="root"></div><script src="${prefix}react.js"></script><script src="${prefix}react-dom.js"></script><script src="${prefix}app-${hash}.js"></script></body></html>`);
 console.log(`${app}: ${dist} (${Object.keys(modules).join(', ')})`);
}
