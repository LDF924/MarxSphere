; installer.nsh — MarxSphere 安装器自定义（V397 桌面端）
!macro customInstall
  DetailPrint "MarxSphere 桌面端安装中…"
!macroend

!macro customUnInstall
  DetailPrint "正在卸载 MarxSphere（用户数据保留在 %APPDATA%\\MarxSphere，可手动删除）"
!macroend
