import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

if (typeof window !== 'undefined') {
    /**
     * Render an offscreen HTML element to PDF bytes (ArrayBuffer).
     * @param {HTMLElement} el
     * @returns {Promise<ArrayBuffer>}
     */
    window.__dirtReportExportToPdfBytes = async function (el) {
        if (!el) throw new Error('Nothing to export');

        const canvas = await html2canvas(el, {
            scale: Math.min(2, window.devicePixelRatio || 1),
            useCORS: true,
            allowTaint: false,
            logging: false,
            backgroundColor: '#ffffff',
            foreignObjectRendering: false,
            removeContainer: true,
        });

        const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 24;
        const contentWidth = pageWidth - margin * 2;
        const imgWidth = contentWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const imgData = canvas.toDataURL('image/png');

        let heightLeft = imgHeight;
        let position = margin;

        pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
        heightLeft -= pageHeight - margin * 2;

        while (heightLeft > 0) {
            position = margin - (imgHeight - heightLeft);
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
            heightLeft -= pageHeight - margin * 2;
        }

        return pdf.output('arraybuffer');
    };
}
