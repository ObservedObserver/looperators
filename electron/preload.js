import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
})
