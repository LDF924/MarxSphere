# VizView 源码解码(VizView-DKRGiXDc.js, 83KB, 闭源 Vue3)
组件: VizThinkingTrace/VizChatPanelV2/VizTaskWindowView/VizView

## data-assistant
- viz_chat_input(success viz_chat_input_filled) / viz_chat_send(trigger viz_chat_message → viz_chat_message_sent) / viz_new_chart

## VizChatPanelV2
- props: compact/inSheet/initialJobId/readOnly; emits: chart-update/multi-chart/figure-caption/data-upload/job-status
- **图表加载**: fetch blob URL(cache no-store) 4 次重试(401/404/408/425/429/500/502/503/504 才重试); base64→Blob URL 缓存 Map(key=前80字+len)
- **Nature 期刊投稿默认参数**: de={journal:"nature", layout:"single-column", colorScheme:"nature-default", dpi:600, fontSize:7, fontFamily:"Arial", axisLineWidth:0.8, dataLineWidth:1, widthMm:89, heightMm:62.3}(89mm 单栏宽!)
- 请求模板: {chartType:"自动判断", journal, journal_name:"Nature", layout, colorScheme...}
- token: skf_auth_token 或 Q.token
