; electron-builder includes build/installer.nsh automatically.
; "Open at login" (on by default) is an HKCU Run value named after the AppUserModelID set in
; src/main/index.ts. The default uninstaller leaves it behind, so every login afterwards tried to
; start a Pi Bot.exe that no longer exists. Remove it, and Task Manager's enabled/disabled flag.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.pibot.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "app.pibot.desktop"
!macroend

; Windows acceptance 2026-11-12: electron-builder's default "is the app running" check stops every
; process whose path starts with $INSTDIR ("...\Programs\Pi Bot"), and the separate runner lives in
; "...\Programs\Pi Bot Runner", so every desktop install or upgrade silently stopped the runner.
; Same logic as the default (_CHECK_APP_RUNNING in allowOnlyOneInstallerInstance.nsh), matching the
; install folder itself ("$INSTDIR\") instead of the name prefix.
!include "getProcessInfo.nsh"
Var pid

!macro PIBOT_FIND_PROCESS _FILE _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
    Pop ${_RETURN}
  ${endIf}
!macroend

!macro PIBOT_KILL_PROCESS _FILE _FORCE
  Push $0
  ${if} ${_FORCE} == 1
    ${if} $IsPowerShellAvailable == 0
      StrCpy $0 "-Force"
    ${else}
      StrCpy $0 "/F"
    ${endIf}
  ${else}
    StrCpy $0 ""
  ${endIf}
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId $0 }"`
  ${else}
    nsExec::Exec `"$CmdPath" /C taskkill $0 /IM "${_FILE}" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"`
  ${endIf}
  Pop $0
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      Sleep 300
    ${endIf}
    !insertmacro PIBOT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        Sleep 1000
        Goto pibotStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK pibotStopProcess
      Quit
      pibotStopProcess:
      DetailPrint "$(appClosing)"
      !insertmacro PIBOT_KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      Sleep 300
      StrCpy $R1 0
      pibotLoop:
        IntOp $R1 $R1 + 1
        !insertmacro PIBOT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro PIBOT_KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro PIBOT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto pibotNotRunning
          ${endIf}
        ${else}
          Goto pibotNotRunning
        ${endIf}
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY pibotLoop
          Quit
        ${else}
          Goto pibotLoop
        ${endIf}
      pibotNotRunning:
    ${endIf}
  ${endIf}
!macroend
