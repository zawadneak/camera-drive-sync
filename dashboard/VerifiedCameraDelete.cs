using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class CameraFileDelete {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Sequential)]
 private struct FileDispositionInfo { [MarshalAs(UnmanagedType.U1)] public bool DeleteFile; }
 [DllImport("kernel32.dll",SetLastError=true)]
 private static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,ref FileDispositionInfo info,uint size);
 private static string Hash(Stream stream){using(var sha=SHA1.Create()){return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}}
 public static void DeleteVerified(string cameraPath,string archivePath,string expectedHash,long expectedBytes){
  if(string.Equals(Path.GetFullPath(cameraPath),Path.GetFullPath(archivePath),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Camera and archive must be different files");
  // Hold the archive open without delete/write sharing until camera removal ends.
  using(var archive=new FileStream(archivePath,FileMode.Open,FileAccess.Read,FileShare.Read)){
   if(archive.Length!=expectedBytes||Hash(archive)!=expectedHash)throw new InvalidOperationException("Local archive verification failed");
   const uint ReadAndDelete=0x80000000u|0x00010000u;
   using(var handle=CreateFile(cameraPath,ReadAndDelete,0,IntPtr.Zero,3,0x00200000u|0x08000000u,IntPtr.Zero)){
    if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
    using(var camera=new FileStream(handle,FileAccess.Read)){
     if(camera.Length!=expectedBytes||Hash(camera)!=expectedHash)throw new InvalidOperationException("Camera file changed; nothing was deleted");
     var disposition=new FileDispositionInfo {DeleteFile=true};
     if(!SetFileInformationByHandle(handle,4,ref disposition,(uint)Marshal.SizeOf(typeof(FileDispositionInfo))))throw new Win32Exception(Marshal.GetLastWin32Error());
    }
   }
  }
 }
}
