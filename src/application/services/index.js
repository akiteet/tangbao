'use strict';
/*
 * 糖包 应用服务层（M5 IPC 服务化）
 *
 * 目的：把渲染层对 window.electron.xxx 的零散调用收敛为领域服务 API（App.services.*），
 * 视图/状态层不再直接接触 IPC 通道。服务方法名与 preload 暴露的通道一一对应，
 * 每个方法自带「electron 不可用」防御（返回 null / {ok:false}），调用方无需再判空。
 *
 * 加载顺序：本文件必须先于 runtime.js（runtime 在脚本解析期就要注册浮窗监听）。
 */
window.App = window.App || {};
App.services = {};
