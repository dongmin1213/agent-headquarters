extends SceneTree
# Test transport only: normal main scene, real key events, rendered pixels. No game state access.
var channel := ""
var active: Dictionary = {}
var held: Array[int] = []
var until_usec := 0
var frame_index := 0
var capture_index := 0
var last_request := ""
var session_clock = preload("session_clock.gd").new(Time.get_ticks_usec())
var frame_log: FileAccess
var event_log: FileAccess
var phase := ""
var settle_frame := 0
var timeline: Array = []
var before_pause := ""
const KEYS = {"A":KEY_A,"D":KEY_D,"W":KEY_W,"S":KEY_S,"J":KEY_J,"K":KEY_K,"L":KEY_L,"Z":KEY_Z,"X":KEY_X,"C":KEY_C,"E":KEY_E,"SPACE":KEY_SPACE,"ENTER":KEY_ENTER,"ESCAPE":KEY_ESCAPE,"TAB":KEY_TAB,"UP":KEY_UP,"DOWN":KEY_DOWN,"LEFT":KEY_LEFT,"RIGHT":KEY_RIGHT}
func _initialize() -> void:
 var args := OS.get_cmdline_user_args()
 if args.size() != 2 or args[0] != "--hq-play-channel":
  push_error("Only --hq-play-channel is allowed; no QA/fixture/replay flags")
  quit(2)
  return
 channel = args[1]
 frame_log = FileAccess.open(channel+"/frames.jsonl",FileAccess.WRITE)
 event_log = FileAccess.open(channel+"/events.jsonl",FileAccess.WRITE)
 call_deferred("boot")
func boot() -> void:
 var scene: PackedScene = load(ProjectSettings.get_setting("application/run/main_scene"))
 if scene == null:
  quit(2)
  return
 var game := scene.instantiate()
 for property in game.get_property_list():
  if property.name == "save_root":
   game.set("save_root", channel+"/save")
 root.add_child(game)
 current_scene = game
 RenderingServer.frame_post_draw.connect(after_draw)
 response({"id":"ready","input":"agent physical-key events through Input.parse_input_event", "fixture":false,"state_injection":false})
func response(value: Dictionary) -> void:
 var f := FileAccess.open(channel+"/response.tmp",FileAccess.WRITE)
 f.store_string(JSON.stringify(value))
 f.close()
 DirAccess.rename_absolute(channel+"/response.tmp",channel+"/response.json")
func record_event(kind: String, data: Dictionary = {}) -> void:
 var row := {"event":kind,"request":active.get("id",last_request),"usec":Time.get_ticks_usec(),"physics_frame":Engine.get_physics_frames()}
 row.merge(data)
 event_log.store_line(JSON.stringify(row))
 event_log.flush()
 if not active.is_empty(): timeline.append(row)
func end_session(reason: String) -> void:
 release_keys()
 record_event("session_exit", {"reason":reason})
 var f := FileAccess.open(channel+"/exit.tmp",FileAccess.WRITE)
 f.store_string(JSON.stringify({"reason":reason,"usec":Time.get_ticks_usec(),"last_request":last_request}))
 f.close()
 DirAccess.rename_absolute(channel+"/exit.tmp",channel+"/exit.json")
 quit()
func press_keys(keys: Array) -> void:
 for key in keys:
  var code: int = KEYS[key]
  var event := InputEventKey.new()
  event.physical_keycode = code
  event.keycode = code
  event.pressed = true
  held.append(code)
  Input.parse_input_event(event)
  record_event("key_down",{"key":key})
func release_keys() -> void:
 for code in held:
  var event := InputEventKey.new()
  event.physical_keycode = code
  event.keycode = code
  event.pressed = false
  Input.parse_input_event(event)
  record_event("key_up",{"keycode":code})
 held.clear()
func capture(path: String) -> int:
 var started := Time.get_ticks_usec()
 var img := root.get_texture().get_image()
 var read_usec := Time.get_ticks_usec()-started
 var error := img.save_png(path)
 record_event("capture",{"read_usec":read_usec,"total_usec":Time.get_ticks_usec()-started,"path":path,"error":error})
 return error
func begin_action() -> void:
 phase = "action"
 record_event("action_start",{"seconds":active.seconds})
 press_keys(active.keys)
 until_usec = Time.get_ticks_usec()+int(float(active.seconds)*1000000)
func finish_action() -> void:
 var shot := channel+"/shot-"+str(active.id)+".png"
 var error := capture(shot)
 var timing_file := channel+"/timing-"+str(active.id)+".json"
 var timing_out := FileAccess.open(timing_file,FileAccess.WRITE)
 timing_out.store_string(JSON.stringify(timeline))
 timing_out.close()
 response({"id":active.id,"screenshot":shot,"before_pause":before_pause,"capture_error":error,"wall_usec":Time.get_ticks_usec(),"frames":capture_index,"input":"agent physical-key events","human_playtest":false,"pause_requested":active.get("pause_after",false),"timing_file":timing_file})
 active = {}
 timeline = []
 before_pause = ""
func advance_action() -> void:
 if phase == "resume_settle":
  if Engine.get_physics_frames() >= settle_frame: begin_action()
  return
 if phase == "pause_settle":
  if Engine.get_physics_frames() >= settle_frame:
   phase = "pause_key"
   press_keys(["ESCAPE"])
   until_usec = Time.get_ticks_usec()+60000
  return
 if phase == "finish_settle":
  if Engine.get_physics_frames() >= settle_frame: finish_action()
  return
 if Time.get_ticks_usec() < until_usec: return
 release_keys()
 if phase == "resume_key":
  phase = "resume_settle"
  settle_frame = Engine.get_physics_frames()+1
 elif phase == "action":
  record_event("action_end")
  if active.get("pause_after",false):
   before_pause = channel+"/before-pause-"+str(active.id)+".png"
   capture(before_pause)
   phase = "pause_settle"
   settle_frame = Engine.get_physics_frames()+1
  else: finish_action()
 elif phase == "pause_key":
  phase = "finish_settle"
  settle_frame = Engine.get_physics_frames()+1
func after_draw() -> void:
 frame_index += 1
 var expiry: String = session_clock.expired(Time.get_ticks_usec())
 if expiry != "":
  end_session(expiry)
  return
 if frame_index % 6 == 0:
  var path := channel+"/frames/%06d.png" % capture_index
  capture(path)
  frame_log.store_line(JSON.stringify({"index":capture_index,"wall_usec":Time.get_ticks_usec(),"request":active.get("id", "idle")}))
  frame_log.flush()
  capture_index += 1
 if not active.is_empty():
  advance_action()
  return
 if not FileAccess.file_exists(channel+"/request.json"): return
 var request = JSON.parse_string(FileAccess.get_file_as_string(channel+"/request.json"))
 if not request is Dictionary or not request.get("id", "") is String: return
 if request.id == last_request: return
 last_request = request.id
 if not last_request.is_valid_int():
  response({"id":last_request,"error":"invalid request ID"})
  return
 if request.get("op") == "stop":
  release_keys()
  response({"id":last_request,"stopped":true})
  end_session("stopped")
  return
 if request.get("op") != "step" or not request.get("keys") is Array:
  response({"id":last_request,"error":"only step(keys, seconds) or stop allowed"})
  return
 var seconds: float = float(request.get("seconds",0))
 if not is_finite(seconds) or seconds < 0.05 or seconds > 5 or request.keys.size() > 8:
  response({"id":last_request,"error":"seconds must be 0.05..5, at most 8 keys"})
  return
 for key in request.keys:
  if not KEYS.has(key):
   response({"id":last_request,"error":"unsupported key"})
   return
 if not request.get("pause_after",false) is bool or not request.get("resume_before",false) is bool:
  response({"id":last_request,"error":"pause flags must be booleans"})
  return
 if (request.get("pause_after",false) or request.get("resume_before",false)) and "ESCAPE" in request.keys:
  response({"id":last_request,"error":"ESCAPE action cannot be combined with pause flags"})
  return
 active = request
 session_clock.touch(Time.get_ticks_usec())
 timeline = []
 record_event("request_received")
 if request.get("resume_before",false):
  phase = "resume_key"
  press_keys(["ESCAPE"])
  until_usec = Time.get_ticks_usec()+60000
 else: begin_action()
