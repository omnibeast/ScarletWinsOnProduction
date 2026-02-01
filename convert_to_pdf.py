#!/usr/bin/env python3
"""
Convert sop.html to sop.pdf using weasyprint or similar
"""
import os
import sys

try:
    from weasyprint import HTML
    
    html_path = r'd:\Prj\ScarletWins\sop.html'
    pdf_path = r'd:\Prj\ScarletWins\sop.pdf'
    
    HTML(html_path).write_pdf(pdf_path)
    print(f"✅ PDF created successfully: {pdf_path}")
    sys.exit(0)
except ImportError:
    print("WeasyPrint not installed, trying alternative method...")
    try:
        import pdfkit
        html_path = r'd:\Prj\ScarletWins\sop.html'
        pdf_path = r'd:\Prj\ScarletWins\sop.pdf'
        pdfkit.from_file(html_path, pdf_path)
        print(f"✅ PDF created successfully: {pdf_path}")
        sys.exit(0)
    except:
        print("❌ No PDF conversion library available")
        print("Install with: pip install weasyprint")
        sys.exit(1)
