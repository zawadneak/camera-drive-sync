using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class CameraDashboardSupervisor {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits information,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinimumWorkingSet,MaximumWorkingSet;public uint ActiveProcesses;public UIntPtr Affinity;public uint PriorityClass,SchedulingClass;}
 [StructLayout(LayoutKind.Sequential)] private struct IoCounters {public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
 private static string Quote(string value){var b=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}b.Append('\\',c=='"'?slashes*2+1:slashes);b.Append(c);slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
 public static int Run(string executable,string script,string root,int port,string logPath){
  IntPtr job=CreateJobObject(IntPtr.Zero,null);
  if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  try{
   var limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // Kill every child when the task process closes the job.
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new Win32Exception(Marshal.GetLastWin32Error());
   using(var log=TextWriter.Synchronized(new StreamWriter(logPath,true,new UTF8Encoding(false)){AutoFlush=true}))
   using(var process=new Process()){
    process.StartInfo=new ProcessStartInfo {FileName=executable,Arguments=Quote(script)+" --root "+Quote(root)+" --port "+port+" --supervised",UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
    process.OutputDataReceived+=(sender,e)=>{if(e.Data!=null)log.WriteLine(e.Data);};
    process.ErrorDataReceived+=(sender,e)=>{if(e.Data!=null)log.WriteLine(e.Data);};
    process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
    if(!AssignProcessToJobObject(job,process.Handle)){process.Kill();throw new Win32Exception(Marshal.GetLastWin32Error());}
    // Node does not load credentials or bind a port until it belongs to the job.
    process.StandardInput.WriteLine("START");process.StandardInput.Close();
    process.WaitForExit();return process.ExitCode;
   }
  }finally{CloseHandle(job);}
 }
}
