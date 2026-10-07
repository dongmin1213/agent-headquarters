#!/usr/bin/env python3
"""Interactive Godot pixel/key transport; no fixture, replay, or state-changing API."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, time, re
HERE=pathlib.Path(__file__).resolve().parent

def restore_save(source, destination, expected_file):
 source=source.resolve()
 if not (source/'session.json').is_file(): raise ValueError('Restore requires an existing recorded play session')
 expected=json.loads(expected_file.read_text())
 if not isinstance(expected,dict) or not expected: raise ValueError('Missing original save hashes')
 blobs={}
 for name,digest in expected.items():
  if pathlib.Path(name).name!=name or name in ('.','..'): raise ValueError('Invalid save filename')
  path=source/'save'/name
  if path.is_symlink() or not path.is_file() or path.stat().st_size>4*1024*1024: raise ValueError('Invalid save file')
  blob=path.read_bytes()
  if hashlib.sha256(blob).hexdigest()!=digest: raise ValueError('Save integrity mismatch: '+name)
  blobs[name]=blob
 destination.mkdir()
 for name,blob in blobs.items(): (destination/name).write_bytes(blob)
 return {'source_session':str(source),'sha256':expected,'restore':'unchanged normal save files; no state edits'}


def main():
 p=argparse.ArgumentParser();p.add_argument('op',choices=['start','step','stop']);p.add_argument('--session',required=True,type=pathlib.Path);p.add_argument('--project',type=pathlib.Path);p.add_argument('--keys',default='');p.add_argument('--seconds',type=float,default=0.1);p.add_argument('--pause-after',action='store_true');p.add_argument('--resume-before',action='store_true');p.add_argument('--restore-session',type=pathlib.Path);p.add_argument('--expected-save-hashes',type=pathlib.Path);p.add_argument('--resolution',default='1440x810');a=p.parse_args()
 if not re.fullmatch(r'[0-9]{3,4}x[0-9]{3,4}',a.resolution):p.error('resolution must be WIDTHxHEIGHT')
 width,height=map(int,a.resolution.split('x'))
 if not (320<=width<=3840 and 180<=height<=2160):p.error('resolution is outside supported capture bounds')
 channel=a.session.resolve()
 if bool(a.restore_session)!=bool(a.expected_save_hashes):p.error('restore requires both original session and expected hashes')
 if a.restore_session and a.op!='start':p.error('restore is only valid for start')
 if a.op=='start':
  if not a.project: p.error('--project is required')
  channel.mkdir(parents=True,exist_ok=False);(channel/'frames').mkdir();(channel/'userdata').mkdir()
  if a.restore_session:
   try: receipt=restore_save(a.restore_session,channel/'save',a.expected_save_hashes)
   except (ValueError,OSError) as error: p.error(str(error))
   (channel/'restore-receipt.json').write_text(json.dumps(receipt,indent=2))
  env={**os.environ,'XDG_DATA_HOME':str(channel/'userdata')}
  log=open(channel/'engine.log','w')
  command=[shutil.which('godot') or 'godot','--path',str(a.project.resolve()),'--log-file',str(channel/'godot.log'),'--rendering-method','gl_compatibility','--resolution',a.resolution,'--max-fps','60','--audio-driver','Dummy','--script',str(HERE/'controller.gd'),'--','--hq-play-channel',str(channel)]
  proc=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True);log.close()
  (channel/'session.json').write_text(json.dumps({'pid':proc.pid,'project':str(a.project.resolve()),'command':command,'started_at':time.time(),'helper_sha256':hashlib.sha256((HERE/'controller.gd').read_bytes()).hexdigest(),'input_method':'agent live physical-key events, no fixture/state injection','audio':'Dummy, not audio evidence'}))
  wanted='ready'
 else:
  if not (channel/'session.json').is_file():p.error('unknown session')
  if not 0.05<=a.seconds<=5:p.error('--seconds must be 0.05..5')
  wanted=str(time.time_ns());request={'id':wanted,'op':a.op,'keys':[k.upper() for k in a.keys.split(',') if k],'seconds':a.seconds,'pause_after':a.pause_after,'resume_before':a.resume_before}
  pending=channel/'request.tmp';pending.write_text(json.dumps(request));pending.replace(channel/'request.json')
  with (channel/'inputs.jsonl').open('a') as f:f.write(json.dumps({**request,'sent_at':time.time()})+'\n')
 end=time.monotonic()+30
 while time.monotonic()<end:
  try:
   result=json.loads((channel/'response.json').read_text())
   if result.get('id')==wanted:
    print(json.dumps(result));return 1 if result.get('error') or result.get('capture_error') else 0
  except (FileNotFoundError,json.JSONDecodeError):pass
  if a.op=='start' and proc.poll() is not None: raise SystemExit('Game exited '+str(proc.returncode)+'; inspect '+str(channel/'engine.log'))
  time.sleep(.05)
 if a.op=='start' and proc.poll() is None: proc.terminate()
 raise SystemExit('No game response within 30 seconds; inspect '+str(channel/'engine.log'))
if __name__=='__main__':raise SystemExit(main())
