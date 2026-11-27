#!/usr/bin/env python3
"""
PROJECT-REPORT.md → PROJECT-REPORT.docx.

Kept in the repo so the Word copy is never hand-edited and out of date: run this
after every report update.  `python3 scripts/report-docx.py PROJECT-REPORT.md PROJECT-REPORT.docx`
"""
import re, sys
from docx import Document
from docx.shared import Pt

src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")
doc = Document()
style = doc.styles["Normal"]
style.font.name = "Calibri"; style.font.size = Pt(10.5)

def add_runs(par, text):
    # inline code + bold
    for token in re.split(r"(`[^`]+`|\*\*[^*]+\*\*)", text):
        if not token:
            continue
        if token.startswith("`") and token.endswith("`") and len(token) > 2:
            r = par.add_run(token[1:-1]); r.font.name = "Consolas"; r.font.size = Pt(9.5)
        elif token.startswith("**") and token.endswith("**") and len(token) > 4:
            r = par.add_run(token[2:-2]); r.bold = True
        else:
            par.add_run(token)

i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith("|") and i + 1 < len(lines) and set(lines[i+1].replace("|","").replace(" ","")) <= set("-:"):
        header = [c.strip() for c in line.strip().strip("|").split("|")]
        rows = []
        i += 2
        while i < len(lines) and lines[i].startswith("|"):
            rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
            i += 1
        table = doc.add_table(rows=1, cols=len(header))
        table.style = "Light Grid Accent 1"
        for j, cell in enumerate(header):
            table.rows[0].cells[j].text = ""
            add_runs(table.rows[0].cells[j].paragraphs[0], cell)
        for row in rows:
            cells = table.add_row().cells
            for j in range(min(len(row), len(header))):
                cells[j].text = ""
                add_runs(cells[j].paragraphs[0], row[j])
        doc.add_paragraph()
        continue
    if line.startswith("# "):
        doc.add_heading(line[2:].strip(), level=0)
    elif line.startswith("## "):
        doc.add_heading(line[3:].strip(), level=1)
    elif line.startswith("### "):
        doc.add_heading(line[4:].strip(), level=2)
    elif line.strip() in ("---", "***"):
        doc.add_paragraph("―" * 20)
    elif re.match(r"^\s*[-*]\s+", line):
        p = doc.add_paragraph(style="List Bullet")
        add_runs(p, re.sub(r"^\s*[-*]\s+", "", line))
    elif re.match(r"^\s*\d+\.\s+", line):
        p = doc.add_paragraph(style="List Number")
        add_runs(p, re.sub(r"^\s*\d+\.\s+", "", line))
    elif line.startswith("```"):
        i += 1
        buf = []
        while i < len(lines) and not lines[i].startswith("```"):
            buf.append(lines[i]); i += 1
        p = doc.add_paragraph()
        r = p.add_run("\n".join(buf)); r.font.name = "Consolas"; r.font.size = Pt(9)
    elif line.strip() == "":
        pass
    else:
        p = doc.add_paragraph()
        add_runs(p, line)
    i += 1

doc.save(dst)
print("wrote", dst)
