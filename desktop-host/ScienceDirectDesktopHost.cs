using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class ScienceDirectDesktopHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static void Main()
    {
        var input = Console.OpenStandardInput();
        var output = Console.OpenStandardOutput();
        var bytes = new byte[4];
        if (!ReadFully(input, bytes)) return;
        var length = BitConverter.ToInt32(bytes, 0);
        if (length <= 0 || length > 32768) return;
        bytes = new byte[length];
        if (!ReadFully(input, bytes)) return;

        object result;
        try
        {
            var request = Json.Deserialize<Dictionary<string, string>>(Encoding.UTF8.GetString(bytes));
            result = Dispatch(request);
        }
        catch (InvalidDataException ex)
        {
            result = new { ok = false, reason = "invalid_pdf", message = ex.Message };
        }
        catch (Exception ex)
        {
            string message = ex is ArgumentException ? ex.Message : "无法写入桌面，请检查文件和文件夹权限。";
            result = new { ok = false, message = message };
        }
        var reply = Encoding.UTF8.GetBytes(Json.Serialize(result));
        output.Write(BitConverter.GetBytes(reply.Length), 0, 4);
        output.Write(reply, 0, reply.Length);
        output.Flush();
    }

    private static object Dispatch(Dictionary<string, string> request)
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string testConfig = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "desktop-dir.txt");
        if (File.Exists(testConfig)) desktop = Path.GetFullPath(File.ReadAllText(testConfig).Trim());
        if (!Directory.Exists(desktop)) throw new ArgumentException("找不到 Windows 桌面文件夹。");

        switch (Get(request, "action"))
        {
            case "name":
                string title = TitleForDesktop(desktop, Get(request, "title"));
                return new { ok = true, filename = Fit(title, DesktopNameLimit(desktop)) + ".pdf" };
            case "source-exists":
                string source = Get(request, "source");
                if (!IsLocalPdf(source)) throw new ArgumentException("无法识别 Edge 下载的 PDF 路径。");
                return new { ok = true, exists = File.Exists(source) };
            case "save":
                return new { ok = true, path = Save(desktop, Get(request, "source"), Get(request, "title")) };
            case "show":
                string path = Get(request, "path");
                if (!IsLocalPdf(path) || !String.Equals(desktop, Path.GetDirectoryName(path), StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                    throw new ArgumentException("桌面上找不到该 PDF。");
                Process.Start(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), "/select,\"" + path + "\"");
                return new { ok = true, path = path };
            default:
                return new { ok = false, message = "无法识别桌面操作。" };
        }
    }

    private static string Save(string desktop, string source, string title)
    {
        if (!IsLocalPdf(source) || !File.Exists(source)) throw new ArgumentException("找不到 Edge 已下载的 PDF。");
        int limit = DesktopNameLimit(desktop);
        string name = TitleForDesktop(desktop, title);

        using (var file = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var header = new byte[5];
            if (!ReadFully(file, header) || Encoding.ASCII.GetString(header) != "%PDF-")
                throw new InvalidDataException("Edge 下载的文件不是有效的 PDF。");
            if (!HasPdfEnd(file)) throw new InvalidDataException("Edge 下载的 PDF 不完整，请在论文页重新下载。");
            file.Position = 0;
            string temp = Path.Combine(desktop, ".sd-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                for (int i = 0; i < 1000; i++)
                {
                    string suffix = i == 0 ? "" : " (" + i + ")";
                    string candidate = Path.Combine(desktop, Fit(name, limit - suffix.Length) + suffix + ".pdf");
                    if (File.Exists(candidate))
                    {
                        if (String.Equals(source, candidate, StringComparison.OrdinalIgnoreCase)) return candidate;
                        if (SamePdf(file, candidate)) return candidate;
                        continue;
                    }
                    if (!File.Exists(temp))
                    {
                        file.Position = 0;
                        using (var copy = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            file.CopyTo(copy);
                            copy.Flush(true);
                        }
                    }
                    try
                    {
                        File.Move(temp, candidate);
                        return candidate;
                    }
                    catch (IOException)
                    {
                        if (!File.Exists(candidate)) throw;
                        if (SamePdf(file, candidate)) return candidate;
                    }
                }
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }
        throw new ArgumentException("同名文件太多，无法创建新的 PDF。");
    }

    private static int DesktopNameLimit(string desktop)
    {
        int limit = Math.Min(255, 258 - desktop.Length - 1) - ".pdf".Length;
        if (limit < 30) throw new ArgumentException("Windows 桌面路径过长，无法保存论文。");
        return limit;
    }

    private static string TitleForDesktop(string desktop, string title)
    {
        if (String.IsNullOrWhiteSpace(title)) throw new ArgumentException("未读取到论文全名，请从论文详情页重新下载。");
        string name = SafeTitle(title);
        if (name.Length == 0) throw new ArgumentException("无法用该论文题名创建文件。");
        return name;
    }

    private static string SafeTitle(string title)
    {
        const string invalid = "<>:\"/\\|?*";
        const string replacements = "＜＞：＂／＼｜？＊";
        var text = new StringBuilder();
        foreach (char ch in Regex.Replace(title, @"[\s\p{Cc}]+", " ").Trim().Trim('.').Trim())
        {
            int position = invalid.IndexOf(ch);
            text.Append(position < 0 ? ch : replacements[position]);
        }
        var name = text.ToString();
        if (Regex.IsMatch(name, @"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\s*(\.|$)", RegexOptions.IgnoreCase)) name = "_" + name;
        return name;
    }

    private static string Fit(string name, int limit)
    {
        if (name.Length <= limit) return name;
        if (Char.IsHighSurrogate(name[limit - 1])) limit--;
        return name.Substring(0, limit).TrimEnd('.', ' ');
    }

    private static bool IsLocalPdf(string value)
    {
        return Regex.IsMatch(value, @"^[A-Za-z]:\\") && String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase) &&
            String.Equals(Path.GetExtension(value), ".pdf", StringComparison.OrdinalIgnoreCase);
    }

    private static bool SamePdf(FileStream source, string candidate)
    {
        using (var existing = new FileStream(candidate, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            if (existing.Length != source.Length) return false;
            source.Position = 0;
            using (var hash = SHA256.Create())
                return Convert.ToBase64String(hash.ComputeHash(source)) == Convert.ToBase64String(hash.ComputeHash(existing));
        }
    }

    private static bool HasPdfEnd(FileStream file)
    {
        var tail = new byte[(int)Math.Min(file.Length, 4096)];
        file.Seek(-tail.Length, SeekOrigin.End);
        if (!ReadFully(file, tail)) return false;
        string trailer = Encoding.ASCII.GetString(tail).TrimEnd('\0', '\t', '\n', '\f', '\r', ' ');
        return trailer.EndsWith("%%EOF", StringComparison.Ordinal);
    }

    private static string Get(Dictionary<string, string> input, string key)
    {
        string value;
        return input != null && input.TryGetValue(key, out value) ? value ?? "" : "";
    }

    private static bool ReadFully(Stream input, byte[] bytes)
    {
        int offset = 0;
        while (offset < bytes.Length)
        {
            int read = input.Read(bytes, offset, bytes.Length - offset);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }
}
