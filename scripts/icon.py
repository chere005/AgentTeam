# Raster export of build/icon.svg for desktop packaging, using only the standard library.
import struct,zlib,pathlib
N=1024
bg=(23,43,41,255);ink=(156,229,205,255)
def rounded(x,y,l,t,w,h,r):
    dx=max(l+r-x,0,x-(l+w-r));dy=max(t+r-y,0,y-(t+h-r))
    return l<=x<=l+w and t<=y<=t+h and dx*dx+dy*dy<=r*r
def line(x,y):return (491<=x<=533 and 335<=y<=521) or (259<=x<=765 and 479<=y<=521) or (259<=x<=301 and 500<=y<=680) or (723<=x<=765 and 500<=y<=680)
rows=[]
for y in range(N):
    row=bytearray([0])
    for x in range(N):
        color=bg if rounded(x,y,0,0,1023,1023,220) else (0,0,0,0)
        if line(x,y):color=ink
        for l,t in ((420,160),(188,680),(652,680)):
            if rounded(x,y,l-21,t-21,226,226,66) and not rounded(x,y,l+21,t+21,142,142,24):color=ink
        row.extend(color)
    rows.append(row)
def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
pathlib.Path('build/icon.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',N,N,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b''))
