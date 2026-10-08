extends RefCounted
# Transport lifetime only. Does not inspect or alter the game's time, pause or save state.
const IDLE_USEC = 15 * 60 * 1000000
const MAX_USEC = 2 * 60 * 60 * 1000000
var started: int
var last_contact: int
func _init(now: int = 0) -> void:
 started = now
 last_contact = now
func touch(now: int) -> void:
 last_contact = now
func expired(now: int) -> String:
 if now - started >= MAX_USEC: return "session_limit_2h"
 if now - last_contact >= IDLE_USEC: return "idle_timeout_15m"
 return ""
