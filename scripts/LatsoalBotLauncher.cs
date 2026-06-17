using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

namespace LatsoalBotLauncher
{
    internal static class Program
    {
        private const string AppUrl = "http://127.0.0.1:8765";

        private static int Main()
        {
            string root = FindProjectRoot();
            if (root == null)
            {
                Console.Error.WriteLine("server.js tidak ditemukan. Jalankan LatsoalBot.exe dari folder project latsoal-bot.");
                return 1;
            }

            if (!CommandExists("node"))
            {
                Console.Error.WriteLine("Node.js belum tersedia di PATH. Install Node.js atau jalankan dari terminal yang sudah mengenali node.");
                return 1;
            }

            if (!IsServerReady())
            {
                StartServer(root);
            }

            if (!WaitForServer())
            {
                Console.Error.WriteLine("Server belum siap. Coba jalankan manual: npm.cmd start");
                return 1;
            }

            OpenBrowser(AppUrl);
            Console.WriteLine("Latsoal Bot berjalan di " + AppUrl);
            Console.WriteLine("Tutup window server Node.js jika ingin menghentikan aplikasi.");
            return 0;
        }

        private static string FindProjectRoot()
        {
            string current = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 4 && !string.IsNullOrEmpty(current); i++)
            {
                if (File.Exists(Path.Combine(current, "server.js")) && File.Exists(Path.Combine(current, "content_generator.py")))
                {
                    return current;
                }
                DirectoryInfo parent = Directory.GetParent(current);
                current = parent == null ? null : parent.FullName;
            }
            return null;
        }

        private static bool CommandExists(string command)
        {
            try
            {
                using (Process process = Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c where " + command,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }))
                {
                    process.WaitForExit(3000);
                    return process.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartServer(string root)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"node server.js\"",
                WorkingDirectory = root,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Minimized
            });
        }

        private static bool WaitForServer()
        {
            for (int i = 0; i < 30; i++)
            {
                if (IsServerReady())
                {
                    return true;
                }
                Thread.Sleep(500);
            }
            return false;
        }

        private static bool IsServerReady()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(AppUrl + "/health");
                request.Timeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void OpenBrowser(string url)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
    }
}
