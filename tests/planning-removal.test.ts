import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildApp } from '../server/app.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultPromptTemplates, normalizePromptTemplates, BASE_SYSTEM, WRITING_SYSTEM, compileTaskPrompt, promptTasks } from '../shared/prompt-templates.js';
import { previousPromptTemplates } from '../shared/previous-prompt-templates.js';
import { previousDramatronPromptTemplates } from '../shared/previous-dramatron-prompt-templates.js';
import type { Job, Settings } from '../shared/types.js';

const stores: Store[]=[]; const engines: StoryEngine[]=[]; const apps: Awaited<ReturnType<typeof buildApp>>[]=[];
afterEach(async()=>{for(const ctx of apps.splice(0))await ctx.app.close();for(const engine of engines.splice(0))await engine.close();for(const store of stores.splice(0))store.close();});
const settings:Settings={providers:[{id:'local',name:'mock',protocol:'openai-chat',baseUrl:'http://unused.invalid',model:'mock',maxOutputTokens:1024,contextTokens:64000}],writingProviderId:'local',planningProviderId:'local',extractionProviderId:'local',taskSettings:{extraction:{autoRetry:false,maxRetries:0,retryDelayMs:0},planning:{enabled:true,mode:'tool'}}};
function fixture(){const store=new Store(mkdtempSync(join(tmpdir(),'novel-planning-removed-')));stores.push(store);const project=store.createProject({title:'移除规划验证'});const models:TextModels={generateText:vi.fn(async()=>({text:'旅人走进港口。',inputTokens:3,outputTokens:4})),generateStructured:vi.fn(async(_provider,_request,validate)=>({value:validate({summary:'旅人抵达港口。',entities:[],relations:[],foreshadows:[]}),inputTokens:2,outputTokens:3}))};const engine=new StoryEngine(store,()=>settings,models);engines.push(engine);return {store,project,models,engine};}
const persist=(store:Store,job:Job)=>store.db.prepare('INSERT INTO jobs(id,branch_id,project_id,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(job.id,job.branchId,job.projectId,job.status,JSON.stringify(job));
async function until(test:()=>boolean){for(let i=0;i<1000;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('等待移除规划验证超时');}

describe('three-task prompts without plot planning',()=>{
  it('keeps only transport protection in general and restores the exact original writing rules in the task',()=>{
    const templates=defaultPromptTemplates();expect(promptTasks).toEqual(['writing','extraction','compression']);expect(templates.presets.planning).toBeUndefined();
    expect(templates.general!.presets[0].blocks.map(block=>block.id)).toEqual(['snow','clear','snow-ack','task-slot','cot-three','cot-single','defense-laoda','defense-normal','continue']);
    const general=templates.general!.presets[0].blocks.filter(block=>block.feature!=='snow').map(block=>block.content).join('\n');
    for(const marker of [BASE_SYSTEM,'DEEPMIND','<char_guide>','日式视觉小说','文风基调','墨守成规','小说作者助手'])expect(general).not.toContain(marker);
    expect(WRITING_SYSTEM).toBe(BASE_SYSTEM+'\n\n'+previousPromptTemplates.presets.writing[0].blocks.find(block=>block.id==='writing-rules')!.content);
    for(const task of promptTasks){const request=compileTaskPrompt(templates,task,{context:'故事资料',summaryText:'剧情摘要',blockText:'[1] 正文。',mode:'original'});expect(request.system.split(BASE_SYSTEM)).toHaveLength(2);expect(request.system).not.toContain('日式视觉小说');}
  });
  it('migrates previous defaults while retaining switches, transport settings, custom edits and archived planning presets',()=>{
    const old=structuredClone(previousDramatronPromptTemplates);old.presets.writing[0].writingOutputMode='tool';old.presets.writing[0].textFilter='dramatron';old.general!.presets[0].blocks.find(block=>block.feature==='snow')!.enabled=false;
    const next=normalizePromptTemplates(old);expect(next.presets.writing[0].writingOutputMode).toBe('tool');expect(next.presets.writing[0].textFilter).toBe('dramatron');expect(next.presets.writing[0].blocks[0].content).toBe(WRITING_SYSTEM);expect(next.general!.presets[0].blocks[0].enabled).toBe(false);expect(next.presets.planning).toEqual(old.presets.planning);expect(normalizePromptTemplates(next)).toEqual(next);
    old.presets.writing[0].blocks[0].content+='\n作者保留的规则';expect(normalizePromptTemplates(old).presets.writing[0].blocks).toEqual(old.presets.writing[0].blocks);
  });
  it('starts writing and extraction without any planner request, tool or legacy plan in the prompt',async()=>{
    const {store,project,engine,models}=fixture();const before=store.state(project.mainBranchId);before.outline.fine=[{chapter:2,title:'历史预期',goal:'LEGACY_PLAN_MARKER'}];store.commit(project.mainBranchId,store.getBranch(project.mainBranchId).revisionId,before,'历史样例');
    engine.start();const job=engine.enqueue(project.mainBranchId,'generate',{baseRevisionId:store.getBranch(project.mainBranchId).revisionId,mode:'original',instruction:'继续'});
    await until(()=>engine.listJobs().find(item=>item.id===job.id)?.status==='completed'&&store.state(project.mainBranchId).chapters[0]?.status==='ready');
    expect(models.generateText).toHaveBeenCalledTimes(1);expect(models.generateStructured).toHaveBeenCalledTimes(1);
    const request=vi.mocked(models.generateText).mock.calls[0][1];expect(request.tools?.some(tool=>tool.name==='update_plot_plan')).toBe(false);expect(JSON.stringify(request.messages)).not.toContain('LEGACY_PLAN_MARKER');expect(engine.listOutputs(job.id).map(output=>output.stage)).toEqual(['writing']);
    expect(store.state(project.mainBranchId).outline.fine).toEqual(before.outline.fine);expect(()=>engine.enqueue(project.mainBranchId,'plan',{baseRevisionId:store.getBranch(project.mainBranchId).revisionId})).toThrow('已移除');
    expect(buildWritingContext({state:store.state(project.mainBranchId),chapterText:id=>store.chapter(project.mainBranchId,id).text}).variables.currentChapterPlan).toBeUndefined();
  });
  it('resumes previously saved prose by organizing materials without re-generating or planning',async()=>{
    const {store,project,engine,models}=fixture();const job=engine.enqueue(project.mainBranchId,'generate',{baseRevisionId:store.getBranch(project.mainBranchId).revisionId,mode:'original',instruction:'旧任务'});
    const saved=store.saveChapter(project.mainBranchId,{baseRevisionId:job.baseRevisionId,title:'已保存正文',text:'已经保存的正文。'});
    job.status='failed';job.baseRevisionId=saved.branch.revisionId;job.payload.generatedChapterId=saved.state.chapters[0].id;job.payload.pendingStage='planning';job.payload.postWritingPlanning='pending';persist(store,job);
    engine.start();engine.action(job.id,'resume');await until(()=>store.state(project.mainBranchId).chapters[0].status==='ready');
    expect(models.generateText).not.toHaveBeenCalled();expect(models.generateStructured).toHaveBeenCalledTimes(1);expect(store.chapter(project.mainBranchId,saved.state.chapters[0].id).text).toBe('已经保存的正文。');expect(engine.listJobs().find(item=>item.id===job.id)?.status).toBe('completed');
  });
  it('retires old planning queues on restart and restore while retaining output and story snapshots',()=>{
    const {store,project,engine}=fixture();const time=new Date().toISOString();const job:Job={id:'legacy-plan',projectId:project.id,branchId:project.mainBranchId,baseRevisionId:store.getBranch(project.mainBranchId).revisionId,kind:'plan',status:'paused',progress:0,total:1,message:'旧规划',inputTokens:2,outputTokens:3,createdAt:time,updatedAt:time,payload:{}};persist(store,job);
    const output=store.outputs.create({jobId:job.id,projectId:job.projectId,branchId:job.branchId,baseRevisionId:job.baseRevisionId,stage:'planning'},{rawResponse:'历史原始输出',text:'历史原始输出',inputTokens:2,outputTokens:3});
    const copy=store.restoreProject(store.exportProject(project.id));expect(engine.listJobs(copy.projectId)[0].status).toBe('cancelled');engine.start();expect(engine.listJobs(project.id)[0].status).toBe('cancelled');expect(store.outputs.get(output.id)!.rawResponse).toBe('历史原始输出');expect(engine.outputDetail(job.id,output.id).canApply).toBe(false);expect(()=>engine.action(job.id,'resume')).toThrow();
  });
  it('removes planning HTTP and preview entry points, ignores legacy task switches, and keeps world editing independent',async()=>{
    const ctx=await buildApp({initialPassword:'removed-planning-fixture',dataDir:mkdtempSync(join(tmpdir(),'novel-no-plan-api-')),startEngine:false});apps.push(ctx);const login=await ctx.app.inject({method:'POST',url:'/api/auth/login',payload:{password:'removed-planning-fixture'}});const cookies={session:login.cookies[0].value};const project=ctx.store.createProject({title:'接口验证'});const baseRevisionId=ctx.store.getBranch(project.mainBranchId).revisionId;
    expect((await ctx.app.inject({method:'POST',url:`/api/branches/${project.mainBranchId}/plan`,cookies,payload:{baseRevisionId}})).statusCode).toBe(404);
    expect((await ctx.app.inject({method:'POST',url:'/api/settings/prompt-preview',cookies,payload:{task:'planning',templates:previousDramatronPromptTemplates,protocol:'openai-chat',variables:{},runtime:{}}})).statusCode).toBe(400);
    const response=await ctx.app.inject({method:'PUT',url:'/api/settings',cookies,payload:{providers:[],writingProviderId:'',planningProviderId:'',extractionProviderId:'',taskSettings:settings.taskSettings}});expect(response.statusCode).toBe(200);expect(response.json().taskSettings.planning).toBeUndefined();
    expect((await ctx.app.inject({method:'PUT',url:`/api/branches/${project.mainBranchId}/outline`,cookies,payload:{baseRevisionId,outline:{locked:'设定',fine:[{chapter:1,title:'新规划',goal:'不得保存'}]}}})).statusCode).toBe(410);
    const changed=await ctx.app.inject({method:'PUT',url:`/api/branches/${project.mainBranchId}/outline`,cookies,payload:{baseRevisionId,outline:{worldview:'港城',locked:'无魔法'}}});expect(changed.statusCode).toBe(200);expect(changed.json().state.outline).toMatchObject({worldview:'港城',locked:'无魔法',fine:[]});
  });
});
