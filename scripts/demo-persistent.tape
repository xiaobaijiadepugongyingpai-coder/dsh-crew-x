# VHS Tape for DSH Crew X Persistent Sessions Demo
# To render this tape into a GIF:
#   vhs scripts/demo-persistent.tape

Output docs/assets/persistent-session-demo.gif

Set FontSize 15
Set FontFamily "JetBrains Mono"
Set Width 1100
Set Height 650
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar "Colorful"
Set BorderRadius 10

# Initial Prompt
Type "# [Turn 1] Start an Opt-in Persistent DSH Session"
Sleep 500ms
Enter

Type 'node -e "const { hub } = await import(\"./src/hub-client.mjs\"); const r = await hub().sessionTurn({ task: \"Investigate intermittent timeout in auth module\", tier: \"pro\", persistent: true }); console.log(JSON.stringify(r, null, 2));"'
Sleep 800ms
Enter
Sleep 2.5s

# Display Turn 1 output highlight
Type "# -> Received session_id: 'session-9b1c-4f8a'. Workspace locked to cwd."
Sleep 500ms
Enter
Sleep 1s

# Turn 2: Reuse the session without re-reading files
Type "# [Turn 2] Follow-up turn on the SAME session (context inherited)"
Sleep 500ms
Enter

Type 'node -e "const { hub } = await import(\"./src/hub-client.mjs\"); const r = await hub().sessionTurn({ session_id: \"session-9b1c-4f8a\", task: \"Apply the mutex lock fix we discussed in Turn 1 and verify\" }); console.log(JSON.stringify({ status: r.status, turn: r.turnIndex, result: r.result.slice(0, 120) + \"...\" }));"'
Sleep 800ms
Enter
Sleep 2.5s

# Display Turn 2 continuation
Type "# -> Turn 2 completed! Worker reused previous findings directly without re-reading files."
Sleep 500ms
Enter
Sleep 1s

# Turn 3: Explicit close
Type "# [Turn 3] Explicitly close session and write tombstone"
Sleep 500ms
Enter

Type 'node -e "const { hub } = await import(\"./src/hub-client.mjs\"); const r = await hub().closeSession(\"session-9b1c-4f8a\"); console.log(\"Session closed:\", r);"'
Sleep 600ms
Enter
Sleep 2s

Type "# Done! Session tombstoned. Re-calling it returns SESSION_CLOSED."
Sleep 1s
Enter
Sleep 2s
