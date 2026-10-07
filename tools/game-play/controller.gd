extends SceneTree
# Test transport only: normal main scene, real key events, rendered pixels. No game state access.
var channel := ""
var active: Dictionary = {}
var held: Array[int] = []
var until_usec := 0
var frame_index := 0
var capture_index := 0
var last_request := ""
var started_usec := Time.get_ticks_usec()
var frame_log: FileAccess
const KEYS = {"A":KEY_A,"D":KEY_D,"W":KEY_W,"S":KEY_S,"J":KEY_J,"K":KEY_K,"L":KEY_L,"Z":KEY_Z,"X":KEY_X,"C":KEY_C,"E":KEY_E,"SPACE":KEY_SPACE,"ENTER":KEY_ENTER,"ESCAPE":KEY_ESCAPE,"TAB":KEY_TAB,"UP":KEY_UP,"DOWN":KEY_DOWN,"LEFT":KEY_LEFT,"RIGHT":KEY_RIGHT}
func _initialize() -> void:
 var args := OS.get_cmdline_user_args()
 if args.size() != 2 or args[0] != "--hq-play-channel":
  push_error("Only --hq-play-channel is allowed; no QA/fixture/replay flags")
  quit(2)
  return
 channel = args[1]
 frame_log = FileAccess.open(channel+"/frames.jsonl",FileAccess.WRITE)
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
func release_keys() -> void:
 for code in held:
  var event := InputEventKey.new()
  event.physical_keycode = code
  event.keycode = code
  event.pressed = false
  Input.parse_input_event(event)
 held.clear()
func after_draw() -> void:
 frame_index += 1
 if Time.get_ticks_usec()-started_usec > 900000000:
  release_keys()
  quit()
  return
 if frame_index % 6 == 0:
  var path := channel+"/frames/%06d.png" % capture_index
  root.get_texture().get_image().save_png(path)
  frame_log.store_line(JSON.stringify({"index":capture_index,"wall_usec":Time.get_ticks_usec(),"request":active.get("id", "idle")}))
  frame_log.flush()
  capture_index += 1
 if not active.is_empty():
  if Time.get_ticks_usec() >= until_usec:
   release_keys()
   var shot := channel+"/shot-"+str(active.id)+".png"
   var error := root.get_texture().get_image().save_png(shot)
   response({"id":active.id,"screenshot":shot,"capture_error":error,"wall_usec":Time.get_ticks_usec(),"frames":capture_index,"input":"agent physical-key events", "human_playtest":false})
   active = {}
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
  quit()
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
 active = request
 until_usec = Time.get_ticks_usec()+int(seconds*1000000)
 for key in request.keys:
  var code: int = KEYS[key]
  var event := InputEventKey.new()
  event.physical_keycode = code
  event.keycode = code
  event.pressed = true
  held.append(code)
  Input.parse_input_event(event)
