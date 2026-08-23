; installer.nsh — MarxSphere 安装器自定义（V397 桌面端）
!macro customInstall
  DetailPrint "MarxSphere 桌面端安装中…"
  ; V413: 放开安装目录写权限（Users 可写）— 普通用户首次启动解压 node_modules 需要写 resources\sag
  ExecWait 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)F /T /Q'
  ExecWait 'icacls "$INSTDIR\resources\sag" /grant *S-1-5-32-545:(OI)(CI)F /T /Q'
  DetailPrint "已放开安装目录写权限（普通用户可解压依赖）"
!macroend

!macro customUnInstall
  DetailPrint "正在卸载 MarxSphere（用户数据保留在 %APPDATA%\MarxSphere，可手动删除）"
!macroend
