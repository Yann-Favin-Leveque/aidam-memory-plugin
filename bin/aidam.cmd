@echo off
REM AIDAM Memory Plugin launcher
REM Sets AIDAM_PARENT_PID so the orchestrator can detect when the session dies

REM Python is fast and reliable to get our parent PID on Windows
"C:\Users\user\AppData\Local\Programs\Python\Python312\python.exe" -c "import os;print(os.getppid())" > "%TEMP%\aidam_pid.txt"
set /p AIDAM_PARENT_PID=<"%TEMP%\aidam_pid.txt"
del "%TEMP%\aidam_pid.txt" 2>nul

claude --plugin-dir "C:\Users\user\IdeaProjects\aidam-memory-plugin" %*
