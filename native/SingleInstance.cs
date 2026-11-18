using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Qingjian
{
    public sealed class SingleInstance : IDisposable
    {
        readonly string pipeName;
        readonly Mutex mutex;
        readonly bool primary;
        volatile bool disposed;
        NamedPipeServerStream server;
        public bool IsPrimary { get { return primary; } }

        public static string ProfilePath(string[] args)
        {
            foreach (string arg in args) if (arg.StartsWith("--profile=")) return Path.GetFullPath(arg.Substring(10));
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Qingjian");
        }

        public SingleInstance(string profile)
        {
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(profile).ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
            pipeName = "Qingjian-" + hash;
            mutex = new Mutex(true, @"Local\" + pipeName, out primary);
        }

        public void Listen(Action<string[]> receive)
        {
            if (!primary) throw new InvalidOperationException();
            Task.Run(async delegate {
                while (!disposed)
                {
                    try
                    {
                        var security = new PipeSecurity();
                        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
                        using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
                        {
                            server = pipe;
                            await pipe.WaitForConnectionAsync();
                            using (var reader = new StreamReader(pipe, Encoding.UTF8))
                            {
                                string line = await reader.ReadLineAsync();
                                if (line != null && line.Length < 65536) receive(new JavaScriptSerializer().Deserialize<string[]>(line));
                            }
                        }
                    }
                    catch (ObjectDisposedException) { break; }
                    catch (IOException) { if (disposed) break; }
                    catch (Exception) { if (disposed) break; Thread.Sleep(250); }
                }
            });
        }

        public void Send(string[] args)
        {
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
            {
                pipe.Connect(4000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true }) writer.WriteLine(new JavaScriptSerializer().Serialize(args));
            }
        }

        public void Dispose()
        {
            disposed = true;
            if (server != null) server.Dispose();
            if (primary) mutex.ReleaseMutex();
            mutex.Dispose();
        }
    }
}
