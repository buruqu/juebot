"""Current-code verification only. Never deploys, opens accounts or production DBs."""
from pathlib import Path
import argparse, datetime, hashlib, json, os, re, subprocess, sys

ROOT=Path(__file__).absolute().parents[1]
NODE=Path(r'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
TSC=Path(r'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def run(argv,log):
    result=subprocess.run([str(a) for a in argv],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
    log.write_bytes(result.stdout)
    decoded=result.stdout.decode('utf-8','replace')
    counts={k:int(m.group(1)) for k in ('tests','pass','fail','cancelled','skipped') if (m:=re.search(r'^# '+k+r' (\d+)\s*$',decoded,re.M))}
    return {'exitCode':result.returncode,'counts':counts,'log':log.relative_to(ROOT).as_posix(),'sha256':sha(log)}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);args=parser.parse_args()
    baseline=json.loads(Path(args.baseline).read_text(encoding='utf-8-sig'))
    def protection():
        for row in baseline:
            if sha(Path(row['Path'])).lower()!=row['Hash'].lower(): raise RuntimeError('Protected input changed: '+row['Path'])
        return {'files':len(baseline),'unchanged':True,'baselineSha256':sha(Path(args.baseline))}
    before=protection()
    sdk_sources=[{'environment':key,'path':os.environ[key],'sha256':sha(Path(os.environ[key]))}
                 for key in ['JUEBOT_DSH_ASSEMBLER_SOURCE','JUEBOT_DSH_CORDIS_MODULE'] if os.environ.get(key)]
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence=ROOT/'next/agent-v1/evidence'/stamp;evidence.mkdir(parents=True,exist_ok=False)
    checks={}
    checks['build']=run([sys.executable,'-X','utf8','-I','-B','tools/build_agent_candidate.py'],evidence/'build.log')
    if checks['build']['exitCode']!=0: raise RuntimeError('Build failed; inspect '+str(evidence/'build.log'))
    checks['coreTypecheck']=run([NODE,TSC,'-p','tsconfig.json','--noEmit','--incremental','false'],evidence/'core-typecheck.log')
    specs=[('legacy',[*ROOT.glob('test/*.test.ts'),*ROOT.glob('test/*.test.mjs')],['--experimental-test-isolation=none']),
           ('social-conversation',[*ROOT.glob('next/social-v1/test/*.test.ts'),*ROOT.glob('next/social-v1/test/*.test.mjs'),*ROOT.glob('next/conversation-v1/test/*.test.ts'),*ROOT.glob('next/conversation-v1/test/*.test.mjs')],[]),
           ('agent',[*ROOT.glob('next/agent-v1/test/*.test.ts'),*ROOT.glob('next/agent-v1/test/*.test.mjs')],[])]
    for name,files,options in specs:
        checks[name]=run([NODE,*options,'--test','--test-reporter=tap',*sorted(files)],evidence/(name+'.tap'))
    checks['packageVerify']=run([sys.executable,'-X','utf8','-I','-B','tools/build_agent_candidate.py','--verify-only'],evidence/'package-verify.log')
    protected=protection()
    files=set()
    for name in ['agent-v1','conversation-v1','social-v1']:
        for part in ['src','host','test']:
            files.update((ROOT/'next'/name/part).rglob('*.ts'));files.update((ROOT/'next'/name/part).rglob('*.js'));files.update((ROOT/'next'/name/part).rglob('*.mjs'))
        files.update((ROOT/'next'/name).glob('tsconfig*.json'))
    files.update((ROOT/'tools').glob('*agent_candidate.py'))
    receipt=json.loads((ROOT/'candidates/0.3.0-dev.6/build-receipt.json').read_text(encoding='utf-8'))
    passed=all(c['exitCode']==0 for c in checks.values()) and all(
      checks[n]['counts'].get('fail',1)==0 and checks[n]['counts'].get('cancelled',1)==0 and checks[n]['counts'].get('skipped',1)==0
      for n in ['legacy','social-conversation','agent'])
    for sdk in sdk_sources:
        if sha(Path(sdk['path']))!=sdk['sha256']: raise RuntimeError('SDK fixture changed during verification')
    summary={'verifiedAtUTC':stamp,'passed':passed,'checks':checks,'protected':protected,'archiveSha256':receipt['archiveSha256'],'payloadFiles':len(receipt['files']),
      'sourceHashes':[{'file':p.relative_to(ROOT).as_posix(),'sha256':sha(p)} for p in sorted(files)],
      'totalTests':sum(c['counts'].get('tests',0) for c in checks.values()),'notTested':['real Host','authenticated production HTTP','native browser visuals','real QQ/Bilibili','paid/real model quality','production database or migration'],
      'tools':{'node':str(NODE),'tsc':str(TSC),'python':sys.executable},'sdkSources':sdk_sources}
    (ROOT/'next/agent-v1/evidence.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':passed,'tests':summary['totalTests'],'groups':{k:v['counts'] for k,v in checks.items()},'evidence':str(evidence),'protected':protected,'archiveSha256':receipt['archiveSha256']},ensure_ascii=False))
    if not passed: sys.exit(1)
if __name__=='__main__':main()
