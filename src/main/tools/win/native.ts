// C# snippets compiled by Add-Type inside Windows PowerShell 5.1 (legacy csc: C# 5 syntax only —
// no string interpolation, expression-bodied members, `out var` or null-conditional operators).

export const CS_INPUT = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class JarvisInput {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  // Coordinates are physical pixels only for a DPI-aware process.
  public static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
    try { if (SetProcessDpiAwareness(2) == 0) return; } catch (Exception) { }
    try { SetProcessDPIAware(); } catch (Exception) { }
  }

  public static int[] Position() {
    POINT p;
    GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed: " + Marshal.GetLastWin32Error());
  }

  public static void Click(string button, int count) {
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int i = 0; i < count; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(20);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      if (i + 1 < count) Thread.Sleep(60);
    }
  }

  // Positive notches scroll down (towards the user), like scroll_dy.
  public static void Scroll(int notches) {
    int steps = Math.Abs(notches);
    int delta = notches > 0 ? -120 : 120;
    for (int i = 0; i < steps; i++) {
      mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
      Thread.Sleep(15);
    }
  }

  static void Key(int vk, bool down, bool extended) {
    uint flags = (extended ? 0x0001u : 0u) | (down ? 0u : 0x0002u);
    keybd_event((byte)vk, (byte)MapVirtualKey((uint)vk, 0), flags, UIntPtr.Zero);
  }

  // Presses vks[0..n-1] in order and releases them in reverse, even if something fails midway.
  public static void Combo(int[] vks, int[] extended) {
    int pressed = 0;
    try {
      for (int i = 0; i < vks.Length; i++) {
        Key(vks[i], true, extended[i] != 0);
        pressed++;
        Thread.Sleep(10);
      }
    } finally {
      for (int i = pressed - 1; i >= 0; i--) {
        Key(vks[i], false, extended[i] != 0);
        Thread.Sleep(10);
      }
    }
  }
}
`

export const CS_WINDOW = String.raw`
using System;
using System.Runtime.InteropServices;

public static class JarvisWindow {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public static bool Focus(long handle) {
    IntPtr hWnd = new IntPtr(handle);
    if (hWnd == IntPtr.Zero) return false;
    if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9);
    if (SetForegroundWindow(hWnd)) return true;
    // A background process may not take the foreground; borrowing the foreground thread's input state lifts that.
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint current = GetCurrentThreadId();
    bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(current, foreground, false);
    }
    return GetForegroundWindow() == hWnd;
  }
}
`

export const CS_AUDIO = String.raw`
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IJarvisAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDb, IntPtr context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, IntPtr context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute(int mute, IntPtr context);
  [PreserveSig] int GetMute(out int mute);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IJarvisMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IJarvisMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IJarvisMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class JarvisMMDeviceEnumerator { }

public static class JarvisAudio {
  static IJarvisAudioEndpointVolume Endpoint() {
    IJarvisMMDeviceEnumerator enumerator = (IJarvisMMDeviceEnumerator)(new JarvisMMDeviceEnumerator());
    IJarvisMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    Guid iid = typeof(IJarvisAudioEndpointVolume).GUID;
    object endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
    return (IJarvisAudioEndpointVolume)endpoint;
  }

  public static float GetLevel() {
    float level;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level));
    return level;
  }

  public static void SetLevel(float level) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level)), IntPtr.Zero));
  }

  public static bool GetMute() {
    int mute;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out mute));
    return mute != 0;
  }

  public static void SetMute(bool mute) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute ? 1 : 0, IntPtr.Zero));
  }
}
`

export const CS_DISPLAY = String.raw`
using System;
using System.Runtime.InteropServices;

public static class JarvisDisplay {
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  // WM_SYSCOMMAND / SC_MONITORPOWER 2 to HWND_BROADCAST; PostMessage never blocks on hung windows.
  public static void Off() {
    PostMessage(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2));
  }
}
`

export const WINDOWS_CSHARP: Readonly<Record<string, string>> = {
  input: CS_INPUT,
  window: CS_WINDOW,
  audio: CS_AUDIO,
  display: CS_DISPLAY
}
