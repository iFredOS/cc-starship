<#
.SYNOPSIS
  Runs one console program inside a Windows pseudo console (ConPTY), drives it with a key
  script, and records every byte it draws.

.DESCRIPTION
  Works in Windows PowerShell 5.1 and PowerShell 7 (the C# below is C# 5 on purpose).
  Everything is described by a JSON job file:

    {
      "commandLine": "\"{run}\\cc-starship.exe\"",   // {run} = the folder holding job.json
      "cwd":         "{run}\\work",                  // optional, default {run}
      "cols": 120, "rows": 40,
      "timeoutMs": 60000,                            // overall; the child (and only it) is killed after
      "env":  { "NAME": "value with {run}", ... },   // added to (or replacing) the inherited environment
      "requireUnderRun": [ "CC_STARSHIP_HOME", ... ],// refuse to start unless each is set and every
                                                     // ';'-separated part lies inside {run}
      "keys": "wait 800\nkey Down\n..."              // key script (see README.md), or
      "keysFile": "{run}\\keys.txt"
    }

  Outputs, all written next to job.json:
    output.raw    every byte the pseudo console emitted, untouched
    timeline.tsv  ms  byteOffset  kind  detail   (start, chunk, step, send, mark, resize, reply, exit, ...)
    env.json      the overrides as the child saw them
    result.json   exit code, timed out?, duration, bytes, processes left in the job, ...
    harness.log   human-readable log

  Safety: the child is created suspended, put in a Job Object with KILL_ON_JOB_CLOSE, then resumed.
  On timeout only that job is terminated: the child and whatever it spawned, nothing else.
#>
param(
  [Parameter(Mandatory = $true)][string]$Job
)
$ErrorActionPreference = 'Stop'
$Job = (Resolve-Path -LiteralPath $Job).Path
$run = Split-Path -Parent $Job
$cfg = Get-Content -LiteralPath $Job -Raw -Encoding UTF8 | ConvertFrom-Json
function Expand([string]$s) { if ($null -eq $s) { return $null }; return $s.Replace('{run}', $run) }

$log = Join-Path $run 'harness.log'
function Log([string]$m) {
  $line = '{0:HH:mm:ss.fff} {1}' -f (Get-Date), $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Host $line
}

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class CcsConPty
{
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int size, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_SUSPENDED = 0x00000004;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    public const uint TIMEOUT_EXIT_CODE = 0xC0DE0124;

    // ── shared state between the reader thread and the step runner ──────────────
    static readonly object Gate = new object();
    static readonly object InputGate = new object(); // key steps and auto-replies write from two threads
    static Stopwatch Clock;
    static StreamWriter Timeline;
    static FileStream Raw;
    static FileStream Input;
    static long Offset;              // bytes written to output.raw so far
    static long LastOutputMs;        // when the last chunk arrived
    static StringBuilder SinceInput = new StringBuilder(); // decoded output since the last key
    static Decoder Utf8 = new UTF8Encoding(false).GetDecoder();
    static bool AutoReply = true;
    static string Pending = "";      // tail kept to spot replies split across chunks
    static Action<string> LogLine;

    static readonly Regex Ansi = new Regex("\x1b\\[[0-9;?<=>!]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]", RegexOptions.Compiled);

    static void Event(string kind, string detail)
    {
        lock (Gate)
        {
            Timeline.WriteLine(Clock.ElapsedMilliseconds + "\t" + Offset + "\t" + kind + "\t" + (detail ?? "").Replace("\t", " ").Replace("\r", "\\r").Replace("\n", "\\n"));
            Timeline.Flush();
        }
    }

    static void Log(string m) { if (LogLine != null) LogLine(m); }

    public static string Visible(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '\x1b') sb.Append("\\e");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20 || c == 0x7f) sb.Append("\\x" + ((int)c).ToString("x2"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static void Send(string data, string label)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(data);
        // Auto-replies (sent from the reader thread) must not reset what a pending waittext sees.
        if (!label.StartsWith("reply(")) lock (Gate) { SinceInput.Length = 0; }
        Event("send", label + " " + Visible(data));
        lock (InputGate)
        {
            try { Input.Write(bytes, 0, bytes.Length); Input.Flush(); }
            catch (Exception e) { Event("send-failed", e.Message); }
        }
    }

    static void Reader(object state)
    {
        var stream = (FileStream)state;
        var buffer = new byte[65536];
        var chars = new char[65536 + 8];
        while (true)
        {
            int n;
            try { n = stream.Read(buffer, 0, buffer.Length); }
            catch (Exception e) { Event("eof", e.GetType().Name); break; }
            if (n <= 0) { Event("eof", "0"); break; }
            string text;
            lock (Gate)
            {
                Raw.Write(buffer, 0, n); Raw.Flush();
                Timeline.WriteLine(Clock.ElapsedMilliseconds + "\t" + Offset + "\tchunk\t" + n);
                Offset += n;
                LastOutputMs = Clock.ElapsedMilliseconds;
                int c = Utf8.GetChars(buffer, 0, n, chars, 0, false);
                text = new string(chars, 0, c);
                SinceInput.Append(text);
            }
            if (AutoReply) Replies(text);
        }
    }

    // ConPTY may ask the terminal questions; nobody is there to answer, so we do.
    static void Replies(string text)
    {
        string s = Pending + text;
        int i = 0;
        while ((i = s.IndexOf('\x1b', i)) >= 0)
        {
            if (Starts(s, i, "\x1b[6n")) Send("\x1b[1;1R", "reply(DSR-CPR)");
            else if (Starts(s, i, "\x1b[c") || Starts(s, i, "\x1b[0c")) Send("\x1b[?61;6;7;22;23;24;28;32;42c", "reply(DA1)");
            else if (Starts(s, i, "\x1b[>c") || Starts(s, i, "\x1b[>0c")) Send("\x1b[>0;10;1c", "reply(DA2)");
            i++;
        }
        Pending = s.Length > 4 ? s.Substring(s.Length - 4) : s;
        // keep only a tail that could be the start of a request
        int esc = Pending.LastIndexOf('\x1b');
        Pending = esc >= 0 ? Pending.Substring(esc) : "";
    }

    static bool Starts(string s, int i, string p) { return string.CompareOrdinal(s, i, p, 0, p.Length) == 0; }

    // ── key script ───────────────────────────────────────────────────────────
    public static string Unescape(string s)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
            char d = s[++i];
            switch (d)
            {
                case 'e': case 'E': sb.Append('\x1b'); break;
                case 'r': sb.Append('\r'); break;
                case 'n': sb.Append('\n'); break;
                case 't': sb.Append('\t'); break;
                case 'b': sb.Append('\b'); break;
                case '0': sb.Append('\0'); break;
                case 's': sb.Append(' '); break;
                case '\\': sb.Append('\\'); break;
                case 'x':
                    sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 2), 16)); i += 2; break;
                case 'u':
                    if (i + 1 < s.Length && s[i + 1] == '{')
                    {
                        int end = s.IndexOf('}', i);
                        sb.Append(char.ConvertFromUtf32(Convert.ToInt32(s.Substring(i + 2, end - i - 2), 16)));
                        i = end;
                    }
                    else { sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; }
                    break;
                case 'c': // \cX = Ctrl+X
                    sb.Append((char)(char.ToUpperInvariant(s[i + 1]) & 0x1f)); i += 1; break;
                default: sb.Append('\\').Append(d); break;
            }
        }
        return sb.ToString();
    }

    public static string KeyBytes(string name)
    {
        switch (name.ToLowerInvariant())
        {
            case "up": return "\x1b[A";
            case "down": return "\x1b[B";
            case "right": return "\x1b[C";
            case "left": return "\x1b[D";
            case "home": return "\x1b[H";
            case "end": return "\x1b[F";
            case "pgup": case "pageup": return "\x1b[5~";
            case "pgdn": case "pagedown": return "\x1b[6~";
            case "insert": return "\x1b[2~";
            case "delete": case "del": return "\x1b[3~";
            case "tab": return "\t";
            case "shifttab": case "backtab": return "\x1b[Z";
            case "enter": case "return": return "\r";
            case "esc": case "escape": return "\x1b";
            case "space": return " ";
            case "backspace": case "bs": return "\x7f";
            case "ctrlc": case "ctrl-c": return "\x03";
            case "ctrld": case "ctrl-d": return "\x04";
            case "f1": return "\x1bOP";
            case "f2": return "\x1bOQ";
            case "f3": return "\x1bOR";
            case "f4": return "\x1bOS";
        }
        if (name.Length == 1) return name;
        throw new ArgumentException("unknown key: " + name);
    }

    static string StrippedSinceInput()
    {
        lock (Gate) { return Ansi.Replace(SinceInput.ToString(), ""); }
    }

    static bool Exited(IntPtr process) { return WaitForSingleObject(process, 0) == WAIT_OBJECT_0; }

    static void Sleep(int ms, IntPtr process, long deadline)
    {
        long until = Clock.ElapsedMilliseconds + ms;
        while (Clock.ElapsedMilliseconds < until && Clock.ElapsedMilliseconds < deadline && !Exited(process)) Thread.Sleep(10);
    }

    static void RunSteps(string script, IntPtr process, IntPtr hpc, long deadline)
    {
        string[] lines = script.Replace("\r\n", "\n").Split('\n');
        for (int n = 0; n < lines.Length; n++)
        {
            // "#" starts a comment at the start of a line or after whitespace (send a literal one as \x23)
            string line = Regex.Replace(lines[n], "(^|\\s)#.*$", "").Trim();
            if (line.Length == 0) continue;
            if (Clock.ElapsedMilliseconds >= deadline) { Event("step-skipped", "timeout: " + line); continue; }
            if (Exited(process)) { Event("step-skipped", "child exited: " + line); continue; }
            int sp = line.IndexOf(' ');
            string op = (sp < 0 ? line : line.Substring(0, sp)).ToLowerInvariant();
            string arg = sp < 0 ? "" : line.Substring(sp + 1);
            string[] parts = arg.Length == 0 ? new string[0] : Regex.Split(arg.Trim(), "\\s+");
            Event("step", (n + 1) + ": " + line);
            switch (op)
            {
                case "wait": case "sleep":
                    Sleep(int.Parse(parts[0]), process, deadline); break;
                case "send": case "type":
                    Send(Unescape(arg), "text"); break;
                case "key": case "press":
                {
                    int count = parts.Length > 1 ? int.Parse(parts[1]) : 1;
                    int gap = parts.Length > 2 ? int.Parse(parts[2]) : 150;
                    for (int k = 0; k < count; k++)
                    {
                        if (k > 0) Sleep(gap, process, deadline);
                        Send(KeyBytes(parts[0]), parts[0]);
                    }
                    break;
                }
                case "waittext": case "expect":
                {
                    // waittext <text...> [timeoutMs]  — matches ANSI-stripped output since the last key
                    string text = arg; int limit = 10000;
                    Match m = Regex.Match(arg, "^(.*\\S)\\s+(\\d+)$");
                    if (m.Success) { text = m.Groups[1].Value; limit = int.Parse(m.Groups[2].Value); }
                    text = Unescape(text.Trim('"'));
                    long until = Math.Min(deadline, Clock.ElapsedMilliseconds + limit);
                    bool ok = false;
                    while (Clock.ElapsedMilliseconds < until && !Exited(process))
                    {
                        if (StrippedSinceInput().Contains(text)) { ok = true; break; }
                        Thread.Sleep(20);
                    }
                    if (!ok && StrippedSinceInput().Contains(text)) ok = true;
                    Event(ok ? "waittext-ok" : "waittext-timeout", text);
                    break;
                }
                case "idle": case "settle":
                {
                    // idle <quietMs> [maxMs] — until no output arrived for quietMs
                    int quiet = parts.Length > 0 ? int.Parse(parts[0]) : 300;
                    int max = parts.Length > 1 ? int.Parse(parts[1]) : 10000;
                    long until = Math.Min(deadline, Clock.ElapsedMilliseconds + max);
                    long started = Clock.ElapsedMilliseconds;
                    while (Clock.ElapsedMilliseconds < until && !Exited(process))
                    {
                        long last; lock (Gate) { last = LastOutputMs; }
                        if (Clock.ElapsedMilliseconds - Math.Max(last, started) >= quiet) break;
                        Thread.Sleep(10);
                    }
                    Event("idle-done", (Clock.ElapsedMilliseconds - started) + "ms");
                    break;
                }
                case "mark": case "snap":
                    Event("mark", arg); break;
                case "resize":
                {
                    var size = new COORD { X = short.Parse(parts[0]), Y = short.Parse(parts[1]) };
                    int hr = ResizePseudoConsole(hpc, size);
                    Event("resize", parts[0] + "x" + parts[1] + " hr=" + hr);
                    break;
                }
                case "waitexit":
                {
                    int limit = parts.Length > 0 ? int.Parse(parts[0]) : 10000;
                    WaitForSingleObject(process, (uint)Math.Max(0, Math.Min(limit, deadline - Clock.ElapsedMilliseconds)));
                    break;
                }
                default:
                    Event("step-error", "unknown step: " + line); break;
            }
        }
        Event("steps-done", "");
    }

    static string EnvBlock(IDictionary overrides)
    {
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string)e.Value;
        foreach (DictionaryEntry e in overrides)
        {
            if (e.Value == null) env.Remove((string)e.Key);
            else env[(string)e.Key] = (string)e.Value;
        }
        var sb = new StringBuilder();
        foreach (var kv in env)
        {
            if (kv.Key.Length == 0 || kv.Key.Contains("=") && !kv.Key.StartsWith("=")) continue;
            sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        }
        sb.Append('\0');
        return sb.ToString();
    }

    public static Hashtable Run(string commandLine, string cwd, int cols, int rows, IDictionary env, string keys,
                                int timeoutMs, string outDir, bool useStdHandles, bool autoReply, Action<string> log)
    {
        LogLine = log; AutoReply = autoReply;
        var result = new Hashtable();
        Clock = Stopwatch.StartNew();
        long deadline = timeoutMs;
        Raw = new FileStream(Path.Combine(outDir, "output.raw"), FileMode.Create, FileAccess.Write, FileShare.Read);
        Timeline = new StreamWriter(Path.Combine(outDir, "timeline.tsv"), false, new UTF8Encoding(false));
        Timeline.WriteLine("ms\toffset\tkind\tdetail");

        IntPtr inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe(in) failed: " + Marshal.GetLastWin32Error());
        if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe(out) failed: " + Marshal.GetLastWin32Error());
        IntPtr hpc;
        int hr = CreatePseudoConsole(new COORD { X = (short)cols, Y = (short)rows }, inRead, outWrite, 0, out hpc);
        if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("x8"));
        // conhost holds its own duplicates of the far ends now
        CloseHandle(inRead); CloseHandle(outWrite);

        var outStream = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 1, false);
        Input = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write, 1, false);
        // Drain output from the start: an undrained pipe blocks conhost and the child with it.
        var reader = new Thread(Reader); reader.IsBackground = true; reader.Start(outStream);

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attrs = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
        if (!UpdateProcThreadAttribute(attrs, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());

        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = attrs;
        // Under ssh our own std handles are pipes; without this the child may write to them instead of the console.
        if (useStdHandles) si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;

        IntPtr envBlock = Marshal.StringToHGlobalUni(EnvBlock(env));
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());

        PROCESS_INFORMATION pi;
        Event("start", cols + "x" + rows + " " + commandLine);
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, envBlock, cwd, ref si, out pi))
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error() + " for " + commandLine);
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int err = Marshal.GetLastWin32Error();
            TerminateJobObject(job, 1); // empty job: harmless
            // The child is ours and suspended; nothing else can be hit by this.
            Process.GetProcessById(pi.dwProcessId).Kill();
            throw new Exception("AssignProcessToJobObject failed: " + err);
        }
        ResumeThread(pi.hThread);
        Event("pid", pi.dwProcessId.ToString());
        result["pid"] = pi.dwProcessId;

        try { RunSteps(keys ?? "", pi.hProcess, hpc, deadline); }
        catch (Exception e) { Event("step-crash", e.Message); result["stepError"] = e.Message; }

        long left = Math.Max(0, deadline - Clock.ElapsedMilliseconds);
        bool exited = WaitForSingleObject(pi.hProcess, (uint)left) == WAIT_OBJECT_0;
        bool timedOut = !exited;
        if (timedOut)
        {
            Event("timeout", "terminating job (child pid " + pi.dwProcessId + " and its descendants only)");
            TerminateJobObject(job, TIMEOUT_EXIT_CODE);
            WaitForSingleObject(pi.hProcess, 5000);
        }
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        Event("exit", code.ToString());
        result["exitCode"] = (long)code;
        result["timedOut"] = timedOut;
        result["exitMs"] = Clock.ElapsedMilliseconds;

        // Let conhost flush what the child drew last, then see what is still running in the job.
        Thread.Sleep(400);
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
        if (QueryInformationJobObject(job, 1, out acct, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
        {
            result["jobTotalProcesses"] = (long)acct.TotalProcesses;
            result["jobActiveAfterExit"] = (long)acct.ActiveProcesses;
            Event("job", "total=" + acct.TotalProcesses + " active=" + acct.ActiveProcesses);
        }
        if (acct.ActiveProcesses > 0) TerminateJobObject(job, TIMEOUT_EXIT_CODE); // stragglers the child started

        // ClosePseudoConsole can block on some builds: do it on a thread with a bounded wait.
        long closeStart = Clock.ElapsedMilliseconds;
        var closer = new Thread(delegate () { ClosePseudoConsole(hpc); });
        closer.IsBackground = true; closer.Start();
        bool closed = closer.Join(5000);
        Event("closed", closed ? "ok" : "ClosePseudoConsole still blocked after 5s");
        result["closeMs"] = Clock.ElapsedMilliseconds - closeStart;
        reader.Join(3000);

        lock (Gate) { result["bytes"] = Offset; }
        result["durationMs"] = Clock.ElapsedMilliseconds;
        try { Input.Dispose(); } catch { }
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job);
        DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); Marshal.FreeHGlobal(envBlock);
        lock (Gate) { Raw.Dispose(); Timeline.Dispose(); }
        return result;
    }
}
'@

# ── validate the job ─────────────────────────────────────────────────────────
$envTable = @{}
if ($cfg.env) { foreach ($p in $cfg.env.PSObject.Properties) { $envTable[$p.Name] = Expand ([string]$p.Value) } }
$runFull = [IO.Path]::GetFullPath($run).TrimEnd('\') + '\'
foreach ($name in @($cfg.requireUnderRun)) {
  if (-not $name) { continue }
  $value = $envTable[$name]
  if ([string]::IsNullOrWhiteSpace($value)) { throw "refusing to run: $name is not set in job.env" }
  foreach ($part in $value.Split(';')) {
    if (-not $part) { continue }
    $full = [IO.Path]::GetFullPath($part)
    if (-not $full.StartsWith($runFull, [StringComparison]::OrdinalIgnoreCase)) {
      throw "refusing to run: $name part '$part' is outside the run folder $runFull"
    }
  }
}
$commandLine = Expand $cfg.commandLine
$cwd = if ($cfg.cwd) { Expand $cfg.cwd } else { $run }
New-Item -ItemType Directory -Force -Path $cwd | Out-Null
$keys = if ($cfg.keysFile) { Get-Content -LiteralPath (Expand $cfg.keysFile) -Raw -Encoding UTF8 } else { [string]$cfg.keys }
$cols = if ($cfg.cols) { [int]$cfg.cols } else { 120 }
$rows = if ($cfg.rows) { [int]$cfg.rows } else { 40 }
$timeoutMs = if ($cfg.timeoutMs) { [int]$cfg.timeoutMs } else { 60000 }
$useStd = if ($null -ne $cfg.useStdHandles) { [bool]$cfg.useStdHandles } else { $true }
$autoReply = if ($null -ne $cfg.autoReply) { [bool]$cfg.autoReply } else { $true }

$envTable | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'env.json') -Encoding UTF8
Log "PowerShell $($PSVersionTable.PSVersion) on $([Environment]::OSVersion.VersionString)"
Log "run folder $run"
Log "command $commandLine  ($cols x $rows, timeout $timeoutMs ms)"
foreach ($k in ($envTable.Keys | Sort-Object)) { Log "env $k=$($envTable[$k])" }

Add-Type -TypeDefinition $source -Language CSharp
# No PowerShell callback is passed: the C# reader thread has no runspace to run one on.
$result = [CcsConPty]::Run($commandLine, $cwd, $cols, $rows, $envTable, $keys, $timeoutMs, $run, $useStd, $autoReply, $null)
$result['cols'] = $cols; $result['rows'] = $rows; $result['commandLine'] = $commandLine; $result['run'] = $run
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'result.json') -Encoding UTF8
Log ("done: exit {0}, timedOut {1}, {2} bytes, {3} ms" -f $result.exitCode, $result.timedOut, $result.bytes, $result.durationMs)
if ($result.timedOut) { exit 124 }
exit 0
