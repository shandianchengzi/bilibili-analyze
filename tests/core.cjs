const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
let source=fs.readFileSync(require('node:path').join(__dirname,'../bilibili_space_video_exporter.user.js'),'utf8');
assert.match(source,/\/\/ @license\s+MIT/);
assert.match(source,/\/\/ @version\s+1\.5\.0/);
source=source.replace('  ensureUiForCurrentPage();\n  ensureChapterUiForCurrentPage();', '  globalThis.testApi={normalizeVideo,toCsv,normalizeChapter,toChapterCsv,signWbi,getMixinKey,normalizeSubtitleUrl,normalizeSubtitleCues,srtTimestamp,toSubtitleSrt,toSubtitleTxt};\n  ensureUiForCurrentPage();\n  ensureChapterUiForCurrentPage();');
const ctx={location:{pathname:'/',href:'https://example.invalid/'},URL,Blob,console,setInterval:()=>{},CryptoJS:{MD5:s=>({toString:()=>crypto.createHash('md5').update(s).digest('hex')})}};
vm.runInNewContext(source,ctx);
const t=ctx.testApi;
const raw={title:'a,"b"',bvid:'BVdemo',aid:1,created:1760000000,pic:'//example.invalid/a.png',meta:{id:3,title:'Collection',ep_count:2}};
const row=t.normalizeVideo(raw,1);
assert.equal(row.season_id,3);
assert.equal(row.in_collection,'是');
assert.equal(row.cover,'https://example.invalid/a.png');
assert.equal(row.raw,raw);
assert.ok(t.toCsv([row]).includes('"a,""b"""'));
assert.ok(t.toCsv([row]).startsWith('\ufeff'));
const ch=t.normalizeChapter({title:'Part',from:220,to:289},2);
assert.equal(ch.start_time,'03:40');
assert.equal(ch.duration_seconds,69);
assert.ok(t.toChapterCsv([ch]).includes('03:40'));
const signed=new URLSearchParams(t.signWbi({mid:1,keyword:"a!b"},'abcdefghijklmnopqrstuvwxyz012345','012345abcdefghijklmnopqrstuvwxyz'));
assert.equal(signed.get('keyword'),'ab');
const hash=signed.get('w_rid');signed.delete('w_rid');
const key=t.getMixinKey('abcdefghijklmnopqrstuvwxyz012345012345abcdefghijklmnopqrstuvwxyz');
assert.equal(hash,crypto.createHash('md5').update(signed.toString()+key).digest('hex'));
const cues=t.normalizeSubtitleCues({body:[
  {from:1.234,to:3.001,content:'第一行\n第二行'},
  {from:3600.005,to:3601.7,content:'字幕二'},
  {from:-1,to:0,content:'无效'}
]});
assert.equal(cues.length,2);
assert.equal(t.srtTimestamp(3600.005),'01:00:00,005');
assert.equal(t.toSubtitleSrt(cues),'1\r\n00:00:01,234 --> 00:00:03,001\r\n第一行\n第二行\r\n\r\n2\r\n01:00:00,005 --> 01:00:01,700\r\n字幕二\r\n');
assert.equal(t.toSubtitleTxt(cues),'第一行\n第二行\n字幕二\n');
assert.equal(t.normalizeSubtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/test.json'),'https://aisubtitle.hdslb.com/bfs/subtitle/test.json');
assert.throws(()=>t.normalizeSubtitleUrl('https://hdslb.com.evil.example/x.json'),/不属于/);
assert.throws(()=>t.normalizeSubtitleUrl('javascript:alert(1)'),/不属于/);
assert.throws(()=>t.normalizeSubtitleCues({body:null}),/body/);
console.log('PASS: metadata, normalized fields, raw retention, CSV escaping/BOM, chapter time, WBI signature.');
