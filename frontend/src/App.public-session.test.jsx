// @vitest-environment happy-dom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {test,expect,vi} from 'vitest'
const native=vi.hoisted(()=>{
  vi.stubEnv('VITE_MOBILE','1');vi.stubEnv('VITE_OPENGYM_PUBLIC_ANDROID','1');vi.stubEnv('VITE_OPENGYM_PERSONAL_BETA','0')
  return {get:vi.fn(async()=>{throw new Error('synthetic locked vault')}),writeFile:vi.fn(),readFile:vi.fn()}
})
vi.mock('@capacitor/core',()=>({Capacitor:{getPlatform:()=> 'android',isNativePlatform:()=>true},registerPlugin:()=>({})}))
vi.mock('@capacitor/app',()=>({App:{addListener:async()=>({remove(){}})}}))
vi.mock('@aparajita/capacitor-secure-storage',()=>({SecureStorage:{get:native.get}}))
vi.mock('@capacitor/filesystem',()=>({Filesystem:{writeFile:native.writeFile,readFile:native.readFile},Directory:{Data:'data'},Encoding:{UTF8:'utf8'}}))
import App from './App.jsx'
import {useStore,DEF} from './store/useStore.js'
import {setLang} from './lib/i18n.js'

test.each([false,true])('real boot and Shell preserve local data on secure-session failure (uncertain timeout: %s)',async uncertain=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  native.get.mockClear().mockRejectedValue(Object.assign(new Error('synthetic vault failure'),uncertain?{code:'secure-storage-timeout'}:{}))
  const previous=useStore.getState(),fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{})
  const state=structuredClone(DEF);state.workouts=[{id:'unsent-workout',d:'2026-11-04',entries:[]}]
  useStore.setState({S:state,ready:false,user:{id:'prior-local-owner',name:'Fixture'},needsMobileOnboarding:false,mobileSessionError:false})
  await setLang('en');const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  try{
    await act(async()=>root.render(<App/>))
    for(let n=0;n<100&&!host.querySelector('[role="alert"]');n++)await act(async()=>new Promise(resolve=>setTimeout(resolve,5)))
    expect(host.textContent).toContain(uncertain?'secure-session-restart-required':'secure-session-unavailable');expect(host.querySelector('#tabbar')).toBeNull()
    const retry=[...host.querySelectorAll('button')].find(button=>button.textContent==='Try again')
    if(uncertain){expect(retry).toBeUndefined();expect(native.get).toHaveBeenCalledTimes(1)}
    else{expect(retry).toBeTruthy();await act(async()=>retry.click());expect(native.get).toHaveBeenCalledTimes(2)}
    expect(useStore.getState().S.workouts).toEqual(state.workouts);expect(useStore.getState().ready).toBe(false)
    expect(native.writeFile).not.toHaveBeenCalled();expect(native.readFile).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
  }finally{
    await act(async()=>root.unmount());host.remove();useStore.setState(previous,true);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs()
  }
})
