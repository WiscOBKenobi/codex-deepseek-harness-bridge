import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { safePath, collectArtifacts, prepareWorkspace } from '../src/workspace.mjs';
async function directory(t){
 const root=await mkdtemp(join(tmpdir(),'codex-ds-files-'));
 t.after(async()=>{assert(!relative(tmpdir(),root).startsWith('..'));await rm(root,{recursive:true,force:true});});
 return root;
}
test('hardlinks and traversal are rejected for file inputs and outputs',async t=>{
 const root=await directory(t);
 await mkdir(join(root,'output')); await writeFile(join(root,'source.txt'),'data');
 await link(join(root,'source.txt'),join(root,'output','linked.txt'));
 await assert.rejects(safePath(root,join(root,'output','linked.txt')),{code:'LINK_DENIED'});
 await assert.rejects(collectArtifacts(root,10000),{code:'LINK_DENIED'});
 await assert.rejects(safePath(root,join(root,'..','outside')),{code:'PATH_DENIED'});
});
test('directory junction cannot escape an output folder',async t=>{
 const root=await directory(t); const outside=await directory(t);
 await mkdir(join(root,'output'));
 await symlink(outside,join(root,'output','escape'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(collectArtifacts(root,10000),{code:'LINK_DENIED'});
});
test('output limits and duplicate input names are enforced',async t=>{
 const root=await directory(t);
 await mkdir(join(root,'output')); await writeFile(join(root,'output','big.txt'),'123456');
 await assert.rejects(collectArtifacts(root,5),{code:'OUTPUT_TOO_LARGE'});
 await mkdir(join(root,'a'));await mkdir(join(root,'b'));
 await writeFile(join(root,'a','same.txt'),'a');await writeFile(join(root,'b','same.txt'),'b');
 await assert.rejects(prepareWorkspace({readRoots:[root],maxInputBytes:100},join(root,'work'),[join(root,'a','same.txt'),join(root,'b','same.txt')]),{code:'DUPLICATE_INPUT_NAME'});
});
