// Run: node tests/demo.mjs (Playwright + Chromium required).
// All network requests are intercepted; screenshots contain fixture data.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = await readFile(new URL('../bilibili_space_video_exporter.user.js', import.meta.url), 'utf8');
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
const uploads = [
  {bvid:'BV1Demo000001',aid:1,title:'演示投稿：现场歌曲整理',author:'演示 UP 主',mid:123456,created:1760000000,length:'12:30',description:'用于界面验证的演示记录',season_id:0},
  {bvid:'BV1Demo000002',aid:2,title:'演示投稿：舞台片段与花絮',author:'演示 UP 主',mid:123456,created:1759900000,length:'06:18',description:'第二条演示记录',season_id:0},
  {bvid:'BV1Demo000003',aid:3,title:'演示投稿：已收录到合集',author:'演示 UP 主',mid:123456,created:1759800000,length:'08:20',season_id:100,meta:{id:100,title:'演示合集',ep_count:1}}
];
let requests=0;
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#00aeec"/><circle cx="160" cy="75" r="35" fill="#ffffff" opacity=".7"/><path d="M150 55L150 95L183 75Z" fill="#00aeec"/><text x="160" y="145" text-anchor="middle" font-size="23" fill="white">DEMO</text></svg>';
await page.route('**/*', async route=>{
 const u=new URL(route.request().url());
 if(u.pathname==='/demo-cover.svg') return route.fulfill({contentType:'image/svg+xml',body:image});
 if(u.hostname==='api.bilibili.com'){
   requests++;
   let data;
   if(u.pathname.endsWith('/nav')) data={wbi_img:{img_url:'https://example.invalid/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://example.invalid/012345abcdefghijklmnopqrstuvwxyz.png'}};
   else if(u.pathname.endsWith('/arc/search')) data={page:{count:3},list:{vlist:uploads.map(v=>({...v,pic:'https://space.bilibili.com/demo-cover.svg'}))}};
   else if(u.pathname.endsWith('/view')) data={aid:42,bvid:'BV1Demo000004',title:'演示视频：章节整理',cid:101,pages:[{page:1,cid:101,part:'演示分 P'}]};
   else data={view_points:[{title:'开场',from:0,to:220,imgUrl:'https://space.bilibili.com/demo-cover.svg'},{title:'第一部分',from:220,to:289,imgUrl:'https://space.bilibili.com/demo-cover.svg'},{title:'第二部分',from:289,to:408,imgUrl:'https://space.bilibili.com/demo-cover.svg'}]};
   return route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data}),headers:{'access-control-allow-origin':route.request().headers().origin||'*','access-control-allow-credentials':'true'}});
 }
 return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:sans-serif;background:#f1f2f3"><h1 style="margin:28px;color:#61666d">bilibili-analyze · 沙箱演示</h1><p style="margin:28px;color:#61666d">实际脚本界面 / 演示数据 / 非真实抓取结果</p></body></html>'});
});
async function load(url){
 await page.goto(url);
 await page.evaluate(()=>{window.demoDownloads=[];window.GM_download=o=>{o.url.text().then(text=>{window.demoDownloads.push({name:o.name,text});o.onload();})};});
 // Test-only synchronous MD5 shim with a known signature value.
 // Live service-side signature verification is outside this fixture test.
 await page.evaluate(()=>{window.CryptoJS={MD5:()=>({toString:()=> 'fixture-md5-signature'})};});
 await page.addScriptTag({content:source});
}
try{
 await mkdir(new URL('../docs/images/',import.meta.url),{recursive:true});
 await load('https://space.bilibili.com/123456/upload/video');
 await page.locator('.bae-start').click();
 await page.locator('#bae-selection-overlay').waitFor();
 assert.equal(await page.locator('.bae-row').count(),2);
 assert.equal(await page.locator('.bae-check:checked').count(),2);
 await page.screenshot({path:new URL('../docs/images/uploads-demo.png',import.meta.url).pathname});
 await page.locator('.bae-filter').selectOption('all');
 assert.equal(await page.locator('.bae-row').count(),3);
 await page.locator('.bae-search').fill('花絮');
 assert.equal(await page.locator('.bae-row').count(),1);
 await page.locator('.bae-close').click();
 const before=requests;
 await page.locator('.bae-reexport').click();
 assert.equal(requests,before);
 await page.getByRole('button',{name:'导出已选视频（2）',exact:true}).click();
 await page.waitForFunction(()=>window.demoDownloads.length===2);
 let files=await page.evaluate(()=>window.demoDownloads);
 assert.equal(JSON.parse(files[0].text).exported_total,2);
 assert.equal(JSON.parse(files[0].text).videos[0].raw.title,uploads[0].title);
 assert.ok(files[1].text.includes('演示投稿'));
 await load('https://www.bilibili.com/video/BV1Demo000004?p=1');
 await page.locator('.bae-fetch-chapter').click();
 await page.locator('#bae-chapter-overlay').waitFor();
 assert.equal(await page.locator('.bae-chapter-row').count(),3);
 await page.screenshot({path:new URL('../docs/images/chapters-demo.png',import.meta.url).pathname});
 await page.locator('.bae-export-chapter-json').click();
 await page.waitForFunction(()=>window.demoDownloads.length===1);
 files=await page.evaluate(()=>window.demoDownloads);
 assert.equal(JSON.parse(files[0].text).chapter_count,3);
 assert.equal(JSON.parse(files[0].text).chapters[1].start_time,'03:40');
 await page.locator('.bae-export-chapter-csv').click();
 await page.waitForFunction(()=>window.demoDownloads.length===2);
 await page.locator('.bae-chapter-close').click();
 const chaptersBefore=requests;
 await page.locator('.bae-view-chapter').click();
 assert.equal(requests,chaptersBefore);
 console.log('PASS: upload filters, cached reopening, JSON/CSV output, chapters; screenshots generated.');
} finally{await browser.close();}
