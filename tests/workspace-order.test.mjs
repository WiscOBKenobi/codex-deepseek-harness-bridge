import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { prepareWorkspace } from '../src/workspace.mjs';

async function setup(t) {
  const base=resolve('.bridge','test-workspace-order');await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'task-'));const workspace=join(root,'workspace');
  t.after(async()=>{const part=relative(base,root);assert(part&&part!=='..'&&!part.startsWith('..'+sep));await rm(root,{recursive:true,force:true});});
  return {root,workspace,config:{harnessRoot:join(root,'upstream'),readRoots:[root],maxInputBytes:10000,prepareWindowsWorkspaceAcl:true}};
}

test('new agent workspace is initialized while empty before any input or output descendant exists',async t=>{
  const {root,workspace,config}=await setup(t);const input=join(root,'source.txt');await writeFile(input,'source bytes');
  let initialized=false;
  const result=await prepareWorkspace(config,workspace,[input],'agent',{initializeWindows:async args=>{
    assert.equal(args.workspace,workspace);assert.equal(args.taskDir,root);assert.equal(args.harnessRoot,config.harnessRoot);
    assert.deepEqual(await readdir(workspace),[]);initialized=true;
  }});
  assert.equal(initialized,true);assert.deepEqual((await readdir(workspace)).sort(),['input','output']);
  assert.equal(await readFile(join(workspace,'input','source.txt'),'utf8'),'source bytes');assert.equal(result[0].path,'input/source.txt');
});

test('files mode and disabled initialization never invoke an ACL initializer',async t=>{
  for(const [mode,enabled] of [['files',true],['agent',false]]){
    const {workspace,config}=await setup(t);
    await prepareWorkspace({...config,prepareWindowsWorkspaceAcl:enabled},workspace,[],mode,{initializeWindows:async()=>assert.fail('Unexpected ACL initialization')});
    assert.deepEqual((await readdir(workspace)).sort(),['input','output']);
  }
});

test('invalid inputs are rejected before directory permission initialization or file copying',async t=>{
  const {root,workspace,config}=await setup(t);const input=join(root,'.env');await writeFile(input,'not for import');
  await assert.rejects(prepareWorkspace(config,workspace,[input],'agent',{initializeWindows:async()=>assert.fail('Unexpected ACL initialization')}),{code:'SENSITIVE_INPUT'});
  await assert.rejects(access(workspace),{code:'ENOENT'});
});

test('initialization failure leaves only an empty task root and never populates files',async t=>{
  const {root,workspace,config}=await setup(t);const input=join(root,'source.txt');await writeFile(input,'source bytes');
  await assert.rejects(prepareWorkspace(config,workspace,[input],'agent',{initializeWindows:async()=>{throw new Error('fixture failure');}}),/fixture failure/);
  assert.deepEqual(await readdir(workspace),[]);assert.equal(await readFile(input,'utf8'),'source bytes');
});
