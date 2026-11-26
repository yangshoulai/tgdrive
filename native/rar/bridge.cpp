// 只接入 7-Zip 的 RAR 读取接口。所有字节经回调传输，归档路径和输出位置留在主进程。
#include <algorithm>
#include <new>

#include "CPP/Common/ComTry.h"
#include "CPP/Common/MyCom.h"
#include "CPP/Common/UTFConvert.h"
#include "CPP/Windows/PropVariant.h"
#include "CPP/7zip/Archive/IArchive.h"
#include "CPP/7zip/IPassword.h"

STDAPI CreateObject(const GUID *, const GUID *, void **);

namespace {

using NWindows::NCOM::CPropVariant;
namespace Result = NArchive::NExtract::NOperationResult;

enum Error { ok, invalid, encrypted, password, missing, unsupported, memory };
enum EntryKind { file, directory, special };

struct Callbacks {
  int (*read)(UInt64 offset, void *buffer, UInt32 size);
  int (*entry)(const char *name, UInt32 length, int kind, UInt64 size);
  int (*write)(const void *buffer, UInt32 size);
  int (*finish)();
};

class Input final : public IInStream, public CMyUnknownImp {
  Z7_IFACES_IMP_UNK_1(IInStream)
  Z7_IFACE_COM7_IMP(ISequentialInStream)
  const Callbacks &io;
  const UInt64 offset, length;
  UInt64 position = 0;
public:
  Input(const Callbacks &callbacks, UInt64 start, UInt64 size)
      : io(callbacks), offset(start), length(size) {}
};

Z7_COM7F_IMF(Input::Read(void *buffer, UInt32 size, UInt32 *processed)) {
  const UInt32 count = position < length
      ? static_cast<UInt32>(std::min<UInt64>({size, length - position, 256 * 1024}))
      : 0;
  if (processed) *processed = 0;
  if (count && io.read(offset + position, buffer, count) < 0) return E_ABORT;
  position += count;
  if (processed) *processed = count;
  return S_OK;
}

Z7_COM7F_IMF(Input::Seek(Int64 delta, UInt32 origin, UInt64 *newPosition)) {
  UInt64 base;
  switch (origin) {
    case STREAM_SEEK_SET: base = 0; break;
    case STREAM_SEEK_CUR: base = position; break;
    case STREAM_SEEK_END: base = length; break;
    default: return E_INVALIDARG;
  }
  if (delta < 0) {
    const UInt64 back = UInt64(0) - static_cast<UInt64>(delta);
    if (back > base) return E_INVALIDARG;
    position = base - back;
  } else {
    if (static_cast<UInt64>(delta) > (UInt64(1) << 63) - 1 - base) return E_INVALIDARG;
    position = base + static_cast<UInt64>(delta);
  }
  if (newPosition) *newPosition = position;
  return S_OK;
}

class Output final : public ISequentialOutStream, public CMyUnknownImp {
  Z7_IFACES_IMP_UNK_1(ISequentialOutStream)
  const Callbacks &io;
public:
  explicit Output(const Callbacks &callbacks) : io(callbacks) {}
};

Z7_COM7F_IMF(Output::Write(const void *buffer, UInt32 size, UInt32 *processed)) {
  if (processed) *processed = 0;
  if (size && io.write(buffer, size) < 0) return E_ABORT;
  if (processed) *processed = size;
  return S_OK;
}

class ArchiveCallbacks final : public IArchiveOpenCallback,
    public IArchiveOpenVolumeCallback, public IArchiveExtractCallback,
    public ICryptoGetTextPassword, public CMyUnknownImp {
  Z7_IFACES_IMP_UNK_4(IArchiveOpenCallback, IArchiveOpenVolumeCallback,
                      IArchiveExtractCallback, ICryptoGetTextPassword)
  Z7_IFACE_COM7_IMP(IProgress)
  const Callbacks &io;
  IInArchive &archive;
  const UInt64 *sizes;
  const UInt32 count;
  const wchar_t *firstName;
  const UString &secret;
  UInt64 offset;
  UInt32 next = 1;
  bool writing = false, entryEncrypted = false;
public:
  bool askedForPassword = false;
  Error error = ok;

  ArchiveCallbacks(const Callbacks &callbacks, IInArchive &reader, const UInt64 *volumes,
                   UInt32 volumeCount, bool numbered, const UString &passphrase)
      : io(callbacks), archive(reader), sizes(volumes), count(volumeCount),
        firstName(numbered ? L"archive.part1.rar" : L"archive.rar"), secret(passphrase),
        offset(volumes[0]) {}
};

Z7_COM7F_IMF(ArchiveCallbacks::SetTotal(const UInt64 *, const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(ArchiveCallbacks::SetCompleted(const UInt64 *, const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(ArchiveCallbacks::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(ArchiveCallbacks::SetCompleted(const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(ArchiveCallbacks::PrepareOperation(Int32)) { return S_OK; }

Z7_COM7F_IMF(ArchiveCallbacks::GetProperty(PROPID id, PROPVARIANT *out)) {
  COM_TRY_BEGIN
  CPropVariant value;
  if (id == kpidName) value = firstName;
  value.Detach(out);
  return S_OK;
  COM_TRY_END
}

Z7_COM7F_IMF(ArchiveCallbacks::GetStream(const wchar_t *, IInStream **out)) {
  COM_TRY_BEGIN
  *out = nullptr;
  // 两种 RAR 处理器都按卷号依次请求下一卷。名称只用来初始化卷号序列。
  if (next == count) return S_FALSE;
  const UInt64 length = sizes[next++];
  CMyComPtr<IInStream> stream(new Input(io, offset, length));
  offset += length;
  *out = stream.Detach();
  return S_OK;
  COM_TRY_END
}

Z7_COM7F_IMF(ArchiveCallbacks::CryptoGetTextPassword(BSTR *out)) {
  askedForPassword = true;
  *out = nullptr;
  if (secret.IsEmpty()) {
    error = encrypted;
    return E_ABORT;
  }
  *out = SysAllocStringLen(secret.Ptr(), secret.Len());
  return *out ? S_OK : E_OUTOFMEMORY;
}

bool flag(const CPropVariant &value) { return value.vt == VT_BOOL && value.boolVal != VARIANT_FALSE; }

Z7_COM7F_IMF(ArchiveCallbacks::GetStream(UInt32 index, ISequentialOutStream **out, Int32 mode)) {
  COM_TRY_BEGIN
  *out = nullptr;
  writing = false;
  CPropVariant value;
  RINOK(archive.GetProperty(index, kpidEncrypted, &value))
  entryEncrypted = flag(value);
  if (mode != NArchive::NExtract::NAskMode::kExtract) return S_OK;

  for (PROPID id : {kpidSplitBefore, kpidSplitAfter}) {
    RINOK(archive.GetProperty(index, id, &value))
    if (flag(value)) {
      error = missing;
      return E_ABORT;
    }
  }
  RINOK(archive.GetProperty(index, kpidIsDir, &value))
  EntryKind kind = flag(value) ? directory : file;
  RINOK(archive.GetProperty(index, kpidAttrib, &value))
  if (value.vt == VT_UI4) {
    const UInt32 attrs = value.ulVal;
    const UInt32 type = attrs >> 16 & 0170000;
    if ((attrs & 0x0400) || ((attrs & 0x8000) && type && type != 0100000 && type != 0040000))
      kind = special;
  }
  for (PROPID id : {kpidSymLink, kpidHardLink, kpidCopyLink, kpidIsAltStream}) {
    RINOK(archive.GetProperty(index, id, &value))
    if (value.vt == VT_BSTR || flag(value)) kind = special;
  }

  RINOK(archive.GetProperty(index, kpidSize, &value))
  if (kind == file && value.vt != VT_UI8) return E_FAIL;
  const UInt64 size = kind == file ? value.uhVal.QuadPart : 0;
  RINOK(archive.GetProperty(index, kpidPath, &value))
  if (value.vt != VT_BSTR || !value.bstrVal) return E_FAIL;
  AString path;
  ConvertUnicodeToUTF8(UString(value.bstrVal), path);
  const int selected = io.entry(path.Ptr(), path.Len(), kind, size);
  if (selected < 0) return E_ABORT;
  if (selected > 0) {
    CMyComPtr<ISequentialOutStream> stream(new Output(io));
    *out = stream.Detach();
    writing = true;
  }
  return S_OK;
  COM_TRY_END
}

Z7_COM7F_IMF(ArchiveCallbacks::SetOperationResult(Int32 result)) {
  if (result == Result::kOK) {
    // 只有解码器已检查 CRC／哈希后才允许提交这个文件。
    return writing && io.finish() < 0 ? E_ABORT : S_OK;
  }
  if (result == Result::kUnsupportedMethod) error = unsupported;
  else if (result == Result::kWrongPassword ||
           (entryEncrypted && (result == Result::kCRCError || result == Result::kDataError)))
    error = password;
  else error = invalid;
  return E_ABORT;
}

Error openArchive(IInArchive &archive, IInStream *input, ArchiveCallbacks *callback, UInt32 count) {
  const UInt64 scan = 0; // 只接受对象开头的 RAR 签名。
  const HRESULT status = archive.Open(input, &scan, callback);
  if (status == E_OUTOFMEMORY) return memory;
  if (callback->error != ok) return callback->error;

  CPropVariant value;
  if (archive.GetArchiveProperty(kpidErrorFlags, &value) != S_OK) return invalid;
  const UInt32 flags = value.vt == VT_UI4 ? value.ulVal : 0;
  if (flags & kpv_ErrorFlags_EncryptedHeadersError) return password;
  if (status != S_OK || flags) return callback->askedForPassword ? password : invalid;
  if (archive.GetArchiveProperty(kpidWarningFlags, &value) != S_OK) return invalid;
  if (value.vt == VT_UI4 && (value.ulVal & kpv_ErrorFlags_HeadersError))
    return callback->askedForPassword ? password : invalid;
  if (archive.GetArchiveProperty(kpidVolumeIndex, &value) != S_OK) return invalid;
  if ((value.vt == VT_UI4 && value.ulVal != 0) || (value.vt == VT_UI8 && value.uhVal.QuadPart != 0))
    return missing;
  if (archive.GetArchiveProperty(kpidError, &value) != S_OK) return invalid;
  if (value.vt == VT_BSTR) return missing;
  if (archive.GetArchiveProperty(kpidNumVolumes, &value) != S_OK || value.vt != VT_UI4 || value.ulVal != count)
    return missing;
  return ok;
}

} // namespace

extern "C" int tessera_extract_rar(const UInt64 *sizes, UInt32 count, int rar5, int numbered,
                                  const char *passphrase, const Callbacks *io) {
  try {
    if (!count) return invalid;
    // 对应 7-Zip ArchiveExports 的 RAR4 与 RAR5 处理器标识。
    GUID id = {k_7zip_GUID_Data1, k_7zip_GUID_Data2, k_7zip_GUID_Data3_Common,
        {0x10, 0, 0, 1, 0x10, static_cast<Byte>(rar5 ? 0xCC : 3), 0, 0}};
    void *handler = nullptr;
    const HRESULT created = CreateObject(&id, &IID_IInArchive, &handler);
    if (created != S_OK) return created == E_OUTOFMEMORY ? memory : unsupported;
    CMyComPtr<IInArchive> archive;
    archive.Attach(static_cast<IInArchive *>(handler));
    UString_Wipe secret;
    if (passphrase) {
      AString_Wipe utf8;
      static_cast<AString &>(utf8) = passphrase;
      if (!ConvertUTF8ToUnicode(utf8, secret)) return password;
    }
    CMyComPtr<IInStream> input(new Input(*io, 0, sizes[0]));
    auto *callback = new ArchiveCallbacks(*io, *archive.Interface(), sizes, count, numbered != 0, secret);
    CMyComPtr<IArchiveOpenCallback> keepCallback(callback);
    const Error status = openArchive(*archive.Interface(), input, callback, count);
    if (status != ok) return status;
    const HRESULT result = archive->Extract(nullptr, static_cast<UInt32>(-1), false, callback);
    if (result == E_OUTOFMEMORY) return memory;
    if (callback->error != ok) return callback->error;
    return result == S_OK ? ok : invalid;
  } catch (const std::bad_alloc &) {
    return memory;
  } catch (...) {
    return invalid;
  }
}
