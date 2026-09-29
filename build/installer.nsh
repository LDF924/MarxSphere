; installer.nsh — SocioSeek 安装器自定义（V397 桌面端）
!macro customInstall
  DetailPrint "SocioSeek 桌面端安装中…"
!macroend

!macro customUnInstall
  DetailPrint "正在卸载 SocioSeek（用户数据保留在 %APPDATA%\\SocioSeek，可手动删除）"
!macroend
