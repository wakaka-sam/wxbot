"""Bounded extraction only: never execute macros, embedded files, or external links."""
import json
import resource
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024, 2 * 1024 * 1024))
LIMIT = 60000
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

def extract(path, extension):
    note = ''
    if extension == '.pdf':
        # Limit both pages and the subprocess output file before reading it.
        target = path + '.txt'
        subprocess.run(['/usr/bin/pdftotext', '-f', '1', '-l', '40', '-layout', '-enc', 'UTF-8', path, target],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=10)
        with open(target, encoding='utf-8') as f:
            text = f.read(LIMIT + 1)
        note = 'PDF 最多读取前 40 页的文字，未分析页面图片及版式'
    else:
        with zipfile.ZipFile(path) as z:
            if len(z.infolist()) > 2000 or sum(i.file_size for i in z.infolist()) > 64 * 1024 * 1024:
                raise ValueError('压缩后的文档展开过大，请拆分')
            def xml(name):
                info = z.getinfo(name)
                if info.file_size > 8 * 1024 * 1024:
                    raise ValueError('文档单个章节过大，请拆分')
                return ET.fromstring(z.read(info))
            if extension == '.docx':
                root = xml('word/document.xml')
                w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
                text = '\n'.join(''.join(p.itertext()) for p in root.iter(w + 'p'))
                note = 'DOCX 读取正文和表格文字，不包含嵌入图片、批注及页眉页脚'
            else:
                strings = []
                if 'xl/sharedStrings.xml' in z.namelist():
                    strings = [''.join(n.itertext()) for n in xml('xl/sharedStrings.xml').iter(NS + 'si')]
                parts = []
                sheets = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'))
                for name in sheets[:5]:
                    parts.append('工作表 ' + name.rsplit('/', 1)[-1])
                    for row in list(xml(name).iter(NS + 'row'))[:200]:
                        cells = []
                        for cell in list(row)[:50]:
                            kind = cell.get('t')
                            value = cell.findtext(NS + 'v') or ''
                            if kind == 's': value = strings[int(value)]
                            elif kind == 'inlineStr': value = ''.join(cell.find(NS + 'is').itertext())
                            formula = cell.findtext(NS + 'f')
                            if formula is not None: value = '[公式缓存值，不重新计算] ' + value
                            cells.append(cell.get('r', '') + '=' + value)
                        parts.append('\t'.join(cells))
                    if sum(map(len, parts)) > LIMIT: break
                text = '\n'.join(parts)
                note = 'XLSX 最多读取前 5 个工作表，每表前 200 行、每行 50 个单元格；公式使用缓存值'
    if len(text) > LIMIT: note += '；文字超过 60000 字符，已截断'
    return {'text': text[:LIMIT], 'note': note}

try:
    print(json.dumps(extract(sys.argv[1], sys.argv[2]), ensure_ascii=False))
except FileNotFoundError:
    print(json.dumps({'error': '服务器缺少文档解析工具，请联系管理员安装 poppler-utils'}))
except Exception:
    print(json.dumps({'error': '文档损坏、加密、过大或无法解析，请转换为文本或图片后重发'}))
