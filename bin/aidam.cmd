@echo off
REM AIDAM Memory Plugin launcher
REM Sets AIDAM_PARENT_PID so the orchestrator can detect when the session dies

REM Python is fast and reliable to get our parent PID on Windows
for /f %%a in ('"C:\Users\user\AppData\Local\Programs\Python\Python312\python.exe" -c "import os; print(os.getppid())"') do set AIDAM_PARENT_PID=%%a

claude --plugin-dir "C:\Users\user\IdeaProjects\aidam-memory-plugin" %*
