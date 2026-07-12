on run argv
	set envWorkspace to do shell script "printf %s \"${OPENCLAW_WORKSPACE:-}\""
	if envWorkspace is not "" then
		set workspacePath to envWorkspace
	else
		set selfPath to POSIX path of (path to me)
		set toolsPath to do shell script "p=" & quoted form of selfPath & "; p=${p%/}; dirname \"$p\""
		set workspacePath to do shell script "cd " & quoted form of (toolsPath & "/..") & " && pwd"
	end if
	set launcherPath to workspacePath & "/tools/paw-push-to-talk.command"
	set logPath to "/tmp/paw-push-to-talk.log"
	set commandText to "cd " & quoted form of workspacePath & "; " & quoted form of launcherPath
	
	repeat with currentArg in argv
		set commandText to commandText & " " & quoted form of (currentArg as text)
	end repeat
	
	set commandText to commandText & " >> " & quoted form of logPath & " 2>&1 &"
	do shell script commandText
	
	display notification "Listening for a short request..." with title "Paw Push-To-Talk"
end run
